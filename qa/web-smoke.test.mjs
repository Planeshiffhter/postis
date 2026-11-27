import assert from 'node:assert/strict';
import test from 'node:test';
import { api, localOrigin } from './support.mjs';

const frontend = localOrigin(
  process.env.POSTIZ_QA_WEB || 'http://localhost:4200'
);
const worker = localOrigin(
  process.env.POSTIZ_QA_WORKER || 'http://localhost:3002'
);

function get(origin, path) {
  return fetch(new URL(path, origin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(90_000),
  });
}

test(
  'web login renders and the calendar redirects anonymous users',
  { timeout: 110_000 },
  async () => {
    const login = await get(frontend, '/auth/login');
    assert.equal(login.status, 200);
    const markup = await login.text();
    assert.match(markup, /<title>Postiz Login<\/title>/);
    assert.match(markup, /type="password"/);

    const calendar = await get(frontend, '/launches');
    assert.ok([302, 307, 308].includes(calendar.status));
    assert.match(
      new URL(calendar.headers.get('location'), frontend).pathname,
      /^\/auth(?:\/|$)/
    );
  }
);

test(
  'API reports readiness and the worker can reach its Temporal namespace',
  { timeout: 25_000 },
  async () => {
    const backend = await api('/');
    assert.equal(backend.status, 200);
    assert.equal(await backend.text(), 'App is running!');

    const status = await get(worker, '/health/status');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { status: 'ok' });
  }
);
