import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { CloudflareStorage } from '../apps/backend/dist/libraries/nestjs-libraries/src/upload/cloudflare.storage.js';
import { RunPodMediaProcessor } from '../apps/backend/dist/libraries/nestjs-libraries/src/upload/runpod.media.processor.js';

test('R2 adapter signs distinct upload and download URLs locally', async () => {
  const storage = new CloudflareStorage(
    'qa-account',
    'qa-access',
    'qa-not-a-real-secret',
    'auto',
    'qa-bucket',
    'https://qa-assets.example.invalid'
  );
  const key = 'qa/folder/image.png';
  const upload = new URL(await storage.signUploadUrl(key, 'image/png'));
  const download = new URL(await storage.signDownloadUrl(key));

  for (const url of [upload, download]) {
    assert.equal(
      url.origin,
      'https://qa-bucket.qa-account.r2.cloudflarestorage.com'
    );
    assert.equal(url.pathname, '/qa/folder/image.png');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '10800');
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.match(url.searchParams.get('X-Amz-Signature'), /^[\da-f]{64}$/);
  }
  assert.notEqual(
    upload.searchParams.get('X-Amz-Signature'),
    download.searchParams.get('X-Amz-Signature')
  );
  assert.equal(
    storage.publicUrl(key),
    'https://qa-assets.example.invalid/' + key
  );
});

test(
  'RunPod adapter submits a job and handles pending, complete, and failed results',
  { timeout: 20_000 },
  async (t) => {
    const received = [];
    const completedOutput = { status: 'ready', duration: 12 };
    const statuses = [
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETED', output: completedOutput },
      { status: 'FAILED', error: 'fixture render failed' },
    ];
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== 'Bearer qa-local-runpod-key') {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST' && request.url === '/v2/qa-render/run') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.end(JSON.stringify({ id: 'qa-job' }));
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/v2/qa-render/status/qa-job' &&
        statuses.length
      ) {
        response.end(JSON.stringify(statuses.shift()));
        return;
      }
      response.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });

    const mockBase = `http://127.0.0.1:${server.address().port}/v2`;
    const originalBase = process.env.RUNPOD_API_URL;
    let processor;
    try {
      process.env.RUNPOD_API_URL = mockBase;
      processor = new RunPodMediaProcessor('qa-local-runpod-key', 'qa-render');
    } finally {
      if (originalBase === undefined) delete process.env.RUNPOD_API_URL;
      else process.env.RUNPOD_API_URL = originalBase;
    }

    const job = { source: 'fixture.mp4', start: 0, end: 12 };
    const jobId = await processor.submit(job);
    assert.equal(jobId, 'qa-job');
    assert.deepEqual(received, [{ input: job }]);
    assert.deepEqual(await processor.status(jobId), { status: 'pending' });
    assert.deepEqual(await processor.status(jobId), {
      status: 'completed',
      result: completedOutput,
    });
    assert.deepEqual(await processor.status(jobId), {
      status: 'failed',
      error: 'fixture render failed',
    });
    assert.deepEqual(statuses, []);
  }
);
