import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { parse } from 'dotenv';
import { createAccount, openLocalDatabase } from './support.mjs';

function localUrl(value, label, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail(`${label} must be a valid loopback address`);
  }
  const allowedHosts = ['127.0.0.1', '[::1]', 'localhost'];
  assert.ok(
    allowedHosts.includes(url.hostname) && protocols.includes(url.protocol),
    `${label} must use loopback`
  );
  return url;
}

async function readJson(response, expectedStatus) {
  assert.equal(response.status, expectedStatus, response.url);
  return response.json();
}

async function waitFor(message, check) {
  const until = Date.now() + 12_000;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    await delay(150);
  } while (Date.now() < until);
  assert.fail(message);
}

test(
  'a draft can be scheduled, rescheduled, and canceled through Temporal',
  { timeout: 60_000 },
  async (t) => {
    const envFile = new URL('../.env', import.meta.url);
    const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
    const temporalAddress =
      process.env.TEMPORAL_ADDRESS ||
      settings.TEMPORAL_ADDRESS ||
      '127.0.0.1:7233';
    const temporalUrl = localUrl(
      `http://${temporalAddress}`,
      'TEMPORAL_ADDRESS',
      ['http:']
    );
    assert.ok(
      temporalUrl.port &&
        temporalUrl.pathname === '/' &&
        !temporalUrl.username &&
        !temporalUrl.password &&
        !temporalUrl.search &&
        !temporalUrl.hash,
      'TEMPORAL_ADDRESS must be a loopback host and port'
    );
    const namespace =
      process.env.TEMPORAL_NAMESPACE ||
      settings.TEMPORAL_NAMESPACE ||
      'default';
    const prisma = await openLocalDatabase();
    t.after(() => prisma.$disconnect());
    const connection = await Connection.connect({
      address: temporalUrl.host,
      connectTimeout: '5s',
    });
    const temporal = new Client({ connection, namespace });
    t.after(() => connection.close());

    const { request, email } = await createAccount();
    const user = await readJson(await request('/user/self'), 200);
    assert.equal(user.email, email);
    assert.ok(user.orgId);
    const organizationId = user.orgId;

    // This fixture cannot publish. The worker's refresh-needed branch returns
    // before provider calls, and the test schedules it days ahead and cancels it.
    const { id: integrationId } = await prisma.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name: 'QA scheduling fixture',
        providerIdentifier: 'mastodon',
        type: 'social',
        token: 'qa-no-provider-credentials',
        disabled: true,
        refreshNeeded: true,
      },
      select: { id: true },
    });

    try {
      const day = 24 * 60 * 60 * 1000;
      const future = (days) => new Date(Date.now() + days * day).toISOString();
      const draftDate = future(2);
      const scheduledDate = future(3);
      const rescheduledDate = future(4);
      const calendarQuery = new URLSearchParams({
        startDate: future(1),
        endDate: future(5),
      });
      const content = 'Postiz QA future-only scheduling fixture';

      async function savePost(type, date, id) {
        const posts = await readJson(
          await request('/posts', {
            method: 'POST',
            json: {
              type,
              date,
              shortLink: false,
              tags: [],
              posts: [
                {
                  integration: { id: integrationId },
                  value: [{ id, content, image: [] }],
                },
              ],
            },
          }),
          201
        );
        assert.equal(posts.length, 1);
        assert.equal(posts[0].integration, integrationId);
        assert.ok(posts[0].postId);
        return posts[0].postId;
      }

      async function calendarPost(postId, state, date) {
        const { p } = await readJson(
          await request(`/posts?${calendarQuery}`),
          200
        );
        const post = p.find((entry) => entry.i === postId);
        assert.equal(post?.s, state);
        assert.equal(post?.d, date);
        assert.ok(post?.g);
        return post;
      }

      const postId = await savePost('draft', draftDate);
      await calendarPost(postId, 'DRAFT', draftDate);

      assert.equal(await savePost('schedule', scheduledDate, postId), postId);
      await calendarPost(postId, 'QUEUE', scheduledDate);
      const workflowId = `post_${postId}`;
      const workflow = temporal.workflow.getHandle(workflowId);

      async function scheduledRun(previousRunId) {
        return waitFor(
          'the Temporal worker did not start the scheduling timer',
          async () => {
            const description = await workflow.describe();
            if (
              description.status.name !== 'RUNNING' ||
              description.runId === previousRunId
            )
              return;
            const run = temporal.workflow.getHandle(
              workflowId,
              description.runId
            );
            const history = await run.fetchHistory();
            if (
              history.events?.some((event) => event.timerStartedEventAttributes)
            )
              return description;
          }
        );
      }

      const initialRun = await scheduledRun();
      assert.equal(initialRun.type, 'postWorkflowV112');
      assert.equal(initialRun.taskQueue, 'main');

      await readJson(
        await request(`/posts/${postId}/date`, {
          method: 'PUT',
          json: { date: rescheduledDate, action: 'schedule' },
        }),
        200
      );
      const rescheduledPost = await calendarPost(
        postId,
        'QUEUE',
        rescheduledDate
      );
      const rescheduledRun = await scheduledRun(initialRun.runId);
      const original = await temporal.workflow
        .getHandle(workflowId, initialRun.runId)
        .describe();
      assert.equal(original.status.name, 'TERMINATED');

      await waitFor(
        'the rescheduled run did not appear in Temporal visibility',
        async () => {
          const executions = temporal.workflow.list({
            query: `WorkflowId = '${workflowId}' AND ExecutionStatus = 'Running'`,
          });
          for await (const execution of executions) {
            if (execution.runId === rescheduledRun.runId) return true;
          }
        }
      );
      assert.deepEqual(
        await readJson(
          await request(`/posts/${rescheduledPost.g}`, { method: 'DELETE' }),
          200
        ),
        { id: postId }
      );
      await waitFor(
        'deleting the post did not terminate the rescheduled run',
        async () => {
          const description = await workflow.describe();
          return description.status.name === 'TERMINATED';
        }
      );
      const { p } = await readJson(
        await request(`/posts?${calendarQuery}`),
        200
      );
      assert.ok(p.every((post) => post.i !== postId));
    } finally {
      const posts = await prisma.post.findMany({
        where: { organizationId, integrationId },
        select: { id: true },
      });
      for (const { id } of posts) {
        const handle = temporal.workflow.getHandle(`post_${id}`);
        try {
          if ((await handle.describe()).status.name === 'RUNNING') {
            await handle.terminate('QA scheduling fixture cleanup');
          }
        } catch (error) {
          if (!(error instanceof WorkflowNotFoundError)) throw error;
        }
      }
      await prisma.$transaction([
        prisma.post.deleteMany({ where: { organizationId, integrationId } }),
        prisma.integration.delete({
          where: { id: integrationId, organizationId },
        }),
      ]);
    }
  }
);
