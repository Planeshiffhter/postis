import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
} from '@temporalio/worker';
import { parse } from 'dotenv';

function temporalAddress() {
  const envFile = new URL('../.env', import.meta.url);
  const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
  const address =
    process.env.TEMPORAL_ADDRESS ||
    settings.TEMPORAL_ADDRESS ||
    '127.0.0.1:7233';
  let url;
  try {
    url = new URL(`http://${address}`);
  } catch {
    assert.fail('TEMPORAL_ADDRESS must use a loopback host and port');
  }
  assert.ok(
    ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      url.port &&
      url.host === address,
    'TEMPORAL_ADDRESS must use a loopback host and port'
  );
  return address;
}

test(
  'clipping workflow retries analysis, renders child clips, and records processor failures',
  { timeout: 90_000 },
  async (t) => {
    const address = temporalAddress();
    const namespace = `postiz-qa-clipping-${randomUUID()}`;
    const connection = await Connection.connect({
      address,
      connectTimeout: '5s',
    });
    t.after(async () => {
      try {
        await connection.withDeadline(Date.now() + 8_000, () =>
          connection.operatorService.deleteNamespace({ namespace })
        );
      } finally {
        await connection.close();
      }
    });
    await connection.withDeadline(Date.now() + 8_000, () =>
      connection.workflowService.registerNamespace({
        namespace,
        workflowExecutionRetentionPeriod: { seconds: 86_400 },
      })
    );

    Runtime.install({
      logger: new DefaultLogger('ERROR'),
      shutdownSignals: [],
    });
    const native = await NativeConnection.connect({ address });
    t.after(() => native.close());
    const analysed = 'source-with-captions';
    const unavailable = 'unavailable-source';
    const rendered = 'rendered-clip';
    const failed = 'failed-clip';
    const calls = [];
    const attempts = new Map();
    const record = (name, metadata) => calls.push({ name, ...metadata });

    // Run the production workflow code on an isolated namespace. The activity
    // fixtures stand in for external processing, transcription, and file storage.
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue: 'main',
      workflowsPath: fileURLToPath(
        new URL(
          '../apps/orchestrator/dist/apps/orchestrator/src/workflows/clipping.workflow.js',
          import.meta.url
        )
      ),
      activities: {
        async submitClippingAnalyse({ clippingId }) {
          const attempt = (attempts.get(clippingId) || 0) + 1;
          attempts.set(clippingId, attempt);
          record('submit analysis', { clippingId, attempt });
          return `${clippingId}-${attempt}`;
        },
        async checkClippingAnalyse({ clippingId, jobId }) {
          record('check analysis', { clippingId, jobId });
          if (clippingId === unavailable) {
            throw ApplicationFailure.nonRetryable(
              'Source video is unavailable',
              'clipping_stop'
            );
          }
          return attempts.get(clippingId) === 1
            ? { state: 'retry' }
            : { state: 'done', transcribe: true };
        },
        async transcribeClipping(input) {
          record('transcribe', input);
        },
        async pickClippingClips(input) {
          record('pick clips', input);
          return [rendered, failed];
        },
        async submitClipFetch({ clipId }) {
          record('submit fetch', { clipId });
          return `fetch-${clipId}`;
        },
        async checkClipFetch(input) {
          record('check fetch', input);
          return { state: 'done' };
        },
        async captionClip(input) {
          record('caption', input);
        },
        async submitClipRender({ clipId }) {
          record('submit render', { clipId });
          return `render-${clipId}`;
        },
        async checkClipRender(input) {
          record('check render', input);
          return { state: input.clipId === failed ? 'failed' : 'done' };
        },
        async failClip(input) {
          record('fail clip', input);
        },
        async createClippingDrafts(input) {
          record('draft clips', input);
        },
        async finishClipping(input) {
          record('finish clipping', input);
        },
        async failClipping(input) {
          record('fail clipping', input);
        },
      },
    });

    const client = new Client({ connection, namespace });
    await worker.runUntil(() =>
      Promise.all(
        [analysed, unavailable].map((clippingId) =>
          client.workflow.execute('clippingWorkflow', {
            workflowId: `qa-${clippingId}`,
            taskQueue: 'main',
            args: [{ clippingId }],
            workflowExecutionTimeout: '60s',
          })
        )
      )
    );

    const namesFor = (key, value) =>
      calls.filter((call) => call[key] === value).map(({ name }) => name);
    assert.deepEqual(namesFor('clippingId', analysed), [
      'submit analysis',
      'check analysis',
      'submit analysis',
      'check analysis',
      'transcribe',
      'pick clips',
      'draft clips',
      'finish clipping',
    ]);
    assert.deepEqual(namesFor('clipId', rendered), [
      'submit fetch',
      'check fetch',
      'caption',
      'submit render',
      'check render',
    ]);
    assert.deepEqual(namesFor('clipId', failed), [
      'submit fetch',
      'check fetch',
      'caption',
      'submit render',
      'check render',
      'fail clip',
    ]);
    assert.deepEqual(
      calls.find(({ name }) => name === 'fail clip'),
      {
        name: 'fail clip',
        clipId: failed,
        error: 'The clip could not be rendered',
        customer: true,
      }
    );
    assert.deepEqual(namesFor('clippingId', unavailable), [
      'submit analysis',
      'check analysis',
      'fail clipping',
    ]);
    assert.deepEqual(
      calls.find(({ name }) => name === 'fail clipping'),
      {
        name: 'fail clipping',
        clippingId: unavailable,
        error: 'Source video is unavailable',
        customer: true,
      }
    );
    const draftIndex = calls.findIndex(({ name }) => name === 'draft clips');
    assert.ok(
      calls.slice(draftIndex + 1).every(({ clipId }) => !clipId),
      'drafting waits for both clip workflows'
    );
  }
);
