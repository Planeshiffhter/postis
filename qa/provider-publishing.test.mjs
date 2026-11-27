import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { parse } from 'dotenv';
import {
  api,
  createAccount,
  localOrigin,
  openLocalDatabase,
} from './support.mjs';

async function readJson(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

async function waitForPublication(connection, workflow) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const { status } = await connection.withDeadline(Date.now() + 5000, () =>
        workflow.describe()
      );
      if (status.name !== 'RUNNING') return status.name;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    await delay(200);
  }
  assert.fail('the local provider publication workflow did not finish');
}

test(
  'a locally connected WordPress fixture publishes through the API and worker',
  {
    skip:
      process.env.POSTIZ_QA_LOCAL_PROVIDER !== '1' &&
      'requires isolated API and worker configured for private providers',
    timeout: 60_000,
  },
  async (t) => {
    const username = 'postiz-qa';
    const password = randomBytes(16).toString('hex');
    const expectedAuth = `Basic ${Buffer.from(
      `${username}:${password}`
    ).toString('base64')}`;
    const externalPostId = 71000;
    const providerUserId = 42;
    const received = [];
    let origin;
    const server = createServer(async (request, response) => {
      const { method, url } = request;
      const authenticated = request.headers.authorization === expectedAuth;
      response.setHeader('content-type', 'application/json');
      const call = { method, url, authenticated };
      received.push(call);
      if (!authenticated) {
        response.writeHead(401).end('{}');
        return;
      }
      if (method === 'GET' && url === '/wp-json/wp/v2/users/me') {
        response.end(
          JSON.stringify({ id: providerUserId, name: 'QA WordPress fixture' })
        );
        return;
      }
      if (method === 'POST' && url === '/wp-json/wp/v2/posts') {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          call.body = JSON.parse(Buffer.concat(chunks).toString());
          response.writeHead(201).end(
            JSON.stringify({
              id: externalPostId,
              link: `${origin}/posts/${externalPostId}`,
            })
          );
        } catch {
          response.writeHead(400).end('{}');
        }
        return;
      }
      response.writeHead(404).end('{}');
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
    origin = localOrigin(`http://127.0.0.1:${server.address().port}`);

    const envFile = new URL('../.env', import.meta.url);
    const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
    const temporalAddress =
      process.env.TEMPORAL_ADDRESS ||
      settings.TEMPORAL_ADDRESS ||
      '127.0.0.1:7233';
    const temporalUrl = new URL(localOrigin(`http://${temporalAddress}`));
    assert.ok(temporalUrl.port, 'TEMPORAL_ADDRESS must include a port');
    const namespace =
      process.env.TEMPORAL_NAMESPACE ||
      settings.TEMPORAL_NAMESPACE ||
      'default';
    const connection = await Connection.connect({
      address: temporalUrl.host,
      connectTimeout: '5s',
    });
    const client = new Client({ connection, namespace });
    t.after(() => connection.close());

    const prisma = await openLocalDatabase();
    t.after(() => prisma.$disconnect());
    const { request, email } = await createAccount();
    const user = await readJson(await request('/user/self'));
    assert.equal(user.email, email);
    assert.ok(user.orgId);
    const organizationId = user.orgId;
    const internalId = `${origin}_${providerUserId}`;

    try {
      const { url: state } = await readJson(
        await request('/integrations/social/wordpress')
      );
      assert.ok(
        state && !state.includes('/'),
        'WordPress connect returned local state'
      );
      const code = Buffer.from(
        JSON.stringify({ domain: origin, username, password })
      ).toString('base64');
      const integration = await readJson(
        await api('/integrations/social-connect/wordpress', {
          method: 'POST',
          json: { state, code, timezone: '0' },
        }),
        201
      );
      assert.ok(integration.id);
      assert.equal(integration.providerIdentifier, 'wordpress');
      assert.equal(integration.internalId, internalId);
      assert.ok(!Object.hasOwn(integration, 'token'));

      const title = 'Postiz QA mock publication';
      const content = '<p>Published only to the loopback test server.</p>';
      const [post] = await readJson(
        await request('/posts', {
          method: 'POST',
          json: {
            type: 'now',
            date: new Date().toISOString(),
            shortLink: false,
            tags: [],
            posts: [
              {
                integration: { id: integration.id },
                settings: {
                  type: 'posts',
                  title,
                  status: 'publish',
                  categories: [3],
                  tags: [7],
                },
                value: [{ content, image: [] }],
              },
            ],
          },
        }),
        201
      );
      assert.ok(post?.postId);
      assert.equal(post.integration, integration.id);

      const workflow = client.workflow.getHandle(`post_${post.postId}`);
      assert.equal(await waitForPublication(connection, workflow), 'COMPLETED');
      assert.deepEqual(received, [
        { method: 'GET', url: '/wp-json/wp/v2/users/me', authenticated: true },
        {
          method: 'POST',
          url: '/wp-json/wp/v2/posts',
          authenticated: true,
          body: {
            title,
            content,
            slug: 'postiz-qa-mock-publication',
            status: 'publish',
            categories: [3],
            tags: [7],
          },
        },
      ]);
      const published = await prisma.post.findUniqueOrThrow({
        where: { id: post.postId, organizationId },
        select: { state: true, releaseId: true, releaseURL: true },
      });
      const releaseURL = `${origin}/posts/${externalPostId}`;
      assert.deepEqual(published, {
        state: 'PUBLISHED',
        releaseId: String(externalPostId),
        releaseURL,
      });
      assert.deepEqual(
        await readJson(await request(`/posts/${post.postId}/release-url`)),
        { releaseURL }
      );
    } finally {
      const integration = await prisma.integration.findUnique({
        where: { organizationId_internalId: { organizationId, internalId } },
        select: { id: true },
      });
      if (integration) {
        const rows = await prisma.post.findMany({
          where: { organizationId, integrationId: integration.id },
          select: { id: true },
        });
        for (const { id } of rows) {
          const workflow = client.workflow.getHandle(`post_${id}`);
          try {
            if ((await workflow.describe()).status.name === 'RUNNING') {
              await workflow.terminate('QA provider fixture cleanup');
            }
          } catch (error) {
            if (!(error instanceof WorkflowNotFoundError)) throw error;
          }
        }
        await prisma.$transaction([
          prisma.errors.deleteMany({
            where: { organizationId, postId: { in: rows.map(({ id }) => id) } },
          }),
          prisma.post.deleteMany({
            where: { organizationId, integrationId: integration.id },
          }),
          prisma.integration.delete({
            where: { id: integration.id, organizationId },
          }),
        ]);
      }
    }
  }
);
