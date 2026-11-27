import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { parse } from 'dotenv';
import { createAccount, localOrigin, openLocalDatabase } from './support.mjs';

test(
  'RSS polling selects the newest item and creates an autopost draft',
  {
    skip:
      process.env.POSTIZ_QA_LOCAL_PROVIDER !== '1' &&
      'requires an isolated API and worker configured for private providers',
    timeout: 55_000,
  },
  async (t) => {
    const feedCalls = [];
    const server = createServer((request, response) => {
      feedCalls.push({ method: request.method, path: request.url });
      if (request.method !== 'GET' || request.url !== '/feed.xml') {
        response.writeHead(404).end();
        return;
      }

      response.setHeader('content-type', 'application/rss+xml; charset=utf-8');
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel>
          <title>Postiz QA RSS fixture</title><link>${origin}</link>
          <description>Loopback feed with two articles</description>
          <item><title>New article</title><link>${newItem}</link>
            <pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate></item>
          <item><title>Old article</title><link>${origin}/old</link>
            <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate></item>
        </channel></rss>`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        })
    );
    const origin = localOrigin(`http://127.0.0.1:${server.address().port}`);
    const newItem = `${origin}/new`;

    const envFile = new URL('../.env', import.meta.url);
    const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
    const temporalAddress =
      process.env.TEMPORAL_ADDRESS ||
      settings.TEMPORAL_ADDRESS ||
      '127.0.0.1:7233';
    const temporalUrl = new URL(localOrigin(`http://${temporalAddress}`));
    assert.ok(temporalUrl.port, 'TEMPORAL_ADDRESS must include a port');
    const connection = await Connection.connect({
      address: temporalUrl.host,
      connectTimeout: '5s',
    });
    const temporal = new Client({
      connection,
      namespace:
        process.env.TEMPORAL_NAMESPACE ||
        settings.TEMPORAL_NAMESPACE ||
        'default',
    });
    t.after(() => connection.close());

    const prisma = await openLocalDatabase();
    t.after(() => prisma.$disconnect());
    const { request, email } = await createAccount();
    const profile = await request('/user/self');
    assert.equal(profile.status, 200);
    const { orgId: organizationId, email: profileEmail } = await profile.json();
    assert.equal(profileEmail, email);

    const integrationId = randomUUID();
    const feedId = randomUUID();
    const workflow = temporal.workflow.getHandle(`autopost-${feedId}`);
    const content = 'QA RSS draft generated only from a loopback feed';
    try {
      await prisma.$transaction([
        prisma.integration.create({
          data: {
            id: integrationId,
            organizationId,
            internalId: randomUUID(),
            name: 'QA RSS fixture channel',
            providerIdentifier: 'mastodon',
            type: 'social',
            token: 'qa-no-provider-credentials',
            disabled: true,
            refreshNeeded: true,
          },
        }),
        prisma.autoPost.create({
          data: {
            id: feedId,
            organizationId,
            title: 'QA loopback feed',
            content,
            url: `${origin}/feed.xml`,
            lastUrl: '',
            active: false,
            onSlot: false,
            syncLast: false,
            addPicture: false,
            generateContent: false,
            integrations: JSON.stringify([{ id: integrationId }]),
          },
        }),
      ]);

      async function setActive(active) {
        const response = await request(`/autopost/${feedId}/active`, {
          method: 'POST',
          json: { active },
        });
        assert.equal(response.status, 201, response.url);
        assert.equal((await response.json()).active, active);
      }

      await setActive(true);
      const deadline = Date.now() + 20_000;
      let completed = false;
      while (Date.now() < deadline && !completed) {
        const { lastUrl } = await prisma.autoPost.findUniqueOrThrow({
          where: { id: feedId, organizationId },
          select: { lastUrl: true },
        });
        if (lastUrl === newItem) {
          const history = await connection.withDeadline(Date.now() + 5000, () =>
            workflow.fetchHistory()
          );
          completed = !!history.events?.some(
            ({ activityTaskCompletedEventAttributes }) =>
              activityTaskCompletedEventAttributes
          );
        }
        if (!completed) await delay(150);
      }

      assert.ok(completed, 'the RSS activity did not complete');
      assert.deepEqual(feedCalls, [{ method: 'GET', path: '/feed.xml' }]);
      const drafts = await prisma.post.findMany({
        where: { organizationId, integrationId },
        select: { state: true, content: true, creationMethod: true },
      });
      assert.deepEqual(drafts, [
        {
          state: 'DRAFT',
          content: `${content}\n\n${newItem}`,
          creationMethod: 'AUTOPOST',
        },
      ]);

      await setActive(false);
      const { status } = await workflow.describe();
      assert.equal(status.name, 'TERMINATED');
    } finally {
      try {
        const { status } = await connection.withDeadline(
          Date.now() + 5000,
          () => workflow.describe()
        );
        if (status.name === 'RUNNING') {
          await connection.withDeadline(Date.now() + 5000, () =>
            workflow.terminate('QA fixture cleanup')
          );
        }
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      } finally {
        await prisma.$transaction([
          prisma.autoPost.deleteMany({ where: { id: feedId, organizationId } }),
          prisma.post.deleteMany({ where: { integrationId, organizationId } }),
          prisma.integration.deleteMany({
            where: { id: integrationId, organizationId },
          }),
        ]);
      }
    }
  }
);
