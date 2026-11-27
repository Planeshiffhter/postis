import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fixtureFrontend,
  listenLoopback,
  startLocalBackend,
} from './local-backend.mjs';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xh5cAAAAASUVORK5CYII=';
const input = 'A blue ceramic mug on a kitchen table';
const refined =
  'A blue ceramic mug on a wooden kitchen table, morning window light';
const fixtureKey = 'sk-postiz-qa-loopback-only';

async function mockImages(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.headers.authorization !== `Bearer ${fixtureKey}`
    ) {
      response.writeHead(401).end();
      return;
    }

    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        route: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
    } catch {
      response.writeHead(400).end();
      return;
    }

    const send = (body) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
    switch (request.url) {
      case '/v1/images/generations':
        send({ created: 1, data: [{ b64_json: png }] });
        break;
      case '/v1/chat/completions':
        send({
          id: 'chatcmpl-postiz-qa',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-6.2-sol',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ prompt: refined }),
              },
            },
          ],
        });
        break;
      default:
        response.writeHead(404).end();
    }
  });
  const port = await listenLoopback(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

async function readJson(response, expected) {
  const result = await response;
  assert.equal(result.status, expected, new URL(result.url).pathname);
  return result.json();
}

test(
  'AI image generation sends the requested prompt and can save a refined image to media',
  { timeout: 45_000 },
  async (t) => {
    const { baseUrl, requests } = await mockImages(t);
    const { origin, uploads } = await startLocalBackend(t, {
      OPENAI_API_KEY: fixtureKey,
      OPENAI_BASE_URL: baseUrl,
    });

    let cookie;
    function call(path, method = 'GET', json) {
      const headers = new Headers();
      if (cookie) headers.set('cookie', cookie);
      if (json) headers.set('content-type', 'application/json');
      return fetch(new URL(path, origin), {
        method,
        headers,
        body: json && JSON.stringify(json),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    }

    const signup = await call('/auth/register', 'POST', {
      email: `postiz-qa-${randomUUID()}@example.invalid`,
      company: 'Postiz Image QA',
      password: randomBytes(20).toString('hex'),
      provider: 'LOCAL',
    });
    assert.equal(signup.status, 200);
    assert.deepEqual(await signup.json(), { register: true });
    cookie = signup.headers
      .getSetCookie()
      .find((value) => value.startsWith('auth='))
      ?.split(';', 1)[0];
    assert.ok(cookie, 'Registration returned a session cookie');

    const raw = await readJson(
      call('/media/generate-image', 'POST', { prompt: input }),
      201
    );
    assert.equal(raw.output, `data:image/png;base64,${png}`);
    assert.deepEqual(requests[0], {
      route: '/v1/images/generations',
      body: { model: 'chatgpt-image-latest', prompt: input, size: '1024x1024' },
    });
    assert.deepEqual((await readJson(call('/media'), 200)).results, []);

    const media = await readJson(
      call('/media/generate-image-with-prompt', 'POST', { prompt: input }),
      201
    );
    assert.ok(media.id, 'The refined image returned a stored media ID');
    try {
      assert.equal(media.status, 'ready');
      assert.equal(requests.length, 3);
      assert.equal(requests[1].route, '/v1/chat/completions');
      assert.equal(requests[1].body.model, 'gpt-6.2-sol');
      assert.ok(
        requests[1].body.messages.some(
          ({ role, content }) =>
            role === 'user' && content === `prompt: ${input}`
        )
      );
      assert.equal(requests[1].body.response_format.type, 'json_schema');
      assert.deepEqual(requests[2], {
        route: '/v1/images/generations',
        body: {
          model: 'chatgpt-image-latest',
          prompt: refined,
          size: '1024x1024',
        },
      });

      const listed = (await readJson(call('/media'), 200)).results;
      assert.ok(
        listed.some(({ id, path }) => id === media.id && path === media.path)
      );
      const url = new URL(media.path);
      assert.equal(url.origin, fixtureFrontend);
      assert.match(
        url.pathname,
        /^\/uploads\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/
      );
      const stored = await readFile(
        join(uploads, url.pathname.slice('/uploads/'.length))
      );
      assert.deepEqual(stored, Buffer.from(png, 'base64'));
    } finally {
      assert.equal(
        (await call(`/media/${encodeURIComponent(media.id)}`, 'DELETE')).status,
        200
      );
    }
  }
);
