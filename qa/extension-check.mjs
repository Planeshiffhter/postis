import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const bundleUrl = new URL(
  '../apps/extension/dist/background.js',
  import.meta.url
);
const bundle = await readFile(bundleUrl, 'utf8');
const manifest = JSON.parse(
  await readFile(
    new URL('../apps/extension/dist/manifest.json', import.meta.url),
    'utf8'
  )
);
const alarmName = 'cookie-refresh';
const skoolCookies = [
  { name: 'client_id', value: 'qa-client' },
  { name: 'auth_token', value: 'qa-auth' },
];
const entry = {
  provider: 'skool',
  jwt: 'qa-jwt',
  backendUrl: 'http://localhost:3000',
};

async function startWorker({
  cookies = skoolCookies,
  cookieError,
  entries = {},
} = {}) {
  const storage = { refreshEntries: structuredClone(entries) };
  const alarms = new Map();
  const requests = [];
  let onMessage;
  let onAlarm;
  const chrome = {
    runtime: {
      onMessageExternal: {
        addListener(listener) {
          onMessage = listener;
        },
      },
    },
    cookies: {
      async getAll({ url }) {
        assert.equal(url, 'https://www.skool.com');
        if (cookieError) throw cookieError;
        return structuredClone(cookies);
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(data) {
          Object.assign(storage, structuredClone(data));
        },
      },
    },
    alarms: {
      onAlarm: {
        addListener(listener) {
          onAlarm = listener;
        },
      },
      async get(name) {
        return alarms.get(name);
      },
      create(name, options) {
        alarms.set(name, structuredClone(options));
      },
      async clear(name) {
        return alarms.delete(name);
      },
    },
  };

  runInNewContext(
    bundle,
    {
      chrome,
      btoa,
      async fetch(url, options) {
        requests.push({ url, options: structuredClone(options) });
        return { ok: true };
      },
    },
    { filename: bundleUrl.pathname, timeout: 1_000 }
  );
  await setImmediate();
  assert.equal(typeof onMessage, 'function');
  assert.equal(typeof onAlarm, 'function');

  return {
    alarms,
    requests,
    storage,
    send(message, sender = { origin: 'http://localhost:4200' }) {
      return new Promise((resolve) => {
        onMessage(message, sender, (response) =>
          resolve(structuredClone(response))
        );
      });
    },
    async fireAlarm(name) {
      onAlarm({ name });
      await setImmediate();
    },
  };
}

test(
  'extension identifies itself, reports providers, and rejects unknown actions',
  { timeout: 5_000 },
  async () => {
    const worker = await startWorker();
    assert.deepEqual(await worker.send({ type: 'PING' }), {
      status: 'ok',
      version: manifest.version,
    });
    const { providers } = await worker.send({ type: 'GET_PROVIDERS' });
    assert.deepEqual(
      providers.find(({ identifier }) => identifier === 'skool'),
      {
        identifier: 'skool',
        name: 'Skool',
        url: 'https://www.skool.com',
        cookieNames: ['client_id', 'auth_token'],
      }
    );
    assert.deepEqual(await worker.send({ type: 'QA_UNKNOWN' }), {
      error: 'Unknown message type: QA_UNKNOWN',
    });
  }
);

test(
  'extension rejects messages from an unlisted origin',
  { timeout: 5_000 },
  async () => {
    const worker = await startWorker();
    const response = await worker.send(
      { type: 'STORE_REFRESH_TOKEN', integrationId: 'unknown', ...entry },
      { origin: 'https://untrusted.example.invalid' }
    );
    assert.deepEqual(response, { error: 'Unauthorized origin' });
    assert.deepEqual(worker.storage.refreshEntries, {});
    assert.equal(worker.alarms.size, 0);
  }
);

test(
  'extension lists missing cookies and exports only registered cookie names',
  { timeout: 5_000 },
  async () => {
    const partial = await startWorker({ cookies: skoolCookies.slice(0, 1) });
    const missing = await partial.send({
      type: 'GET_COOKIES',
      provider: 'skool',
    });
    assert.equal(missing.success, false);
    assert.deepEqual(missing.missingCookies, ['auth_token']);

    const worker = await startWorker({
      cookies: [...skoolCookies, { name: 'ignored', value: 'qa-unrelated' }],
    });
    assert.deepEqual(
      await worker.send({ type: 'GET_COOKIES', provider: 'skool' }),
      {
        success: true,
        provider: 'skool',
        cookies: { client_id: 'qa-client', auth_token: 'qa-auth' },
      }
    );
    const unknown = await worker.send({
      type: 'GET_COOKIES',
      provider: 'qa-unknown',
    });
    assert.equal(unknown.success, false);
    assert.match(unknown.error, /Unknown provider/);
  }
);

test(
  'extension reports Chrome cookie access failure',
  { timeout: 5_000 },
  async () => {
    const worker = await startWorker({
      cookieError: new Error('QA cookie read failed'),
    });
    const result = await worker.send({
      type: 'GET_COOKIES',
      provider: 'skool',
    });
    assert.equal(result.success, false);
    assert.match(result.error, /QA cookie read failed/);
  }
);

test(
  'extension stores tokens and clears the alarm after the final token is removed',
  { timeout: 5_000 },
  async () => {
    const worker = await startWorker();
    for (const integrationId of ['first', 'second']) {
      assert.deepEqual(
        await worker.send({
          type: 'STORE_REFRESH_TOKEN',
          integrationId,
          ...entry,
        }),
        { success: true }
      );
      assert.deepEqual(worker.storage.refreshEntries[integrationId], entry);
    }
    assert.equal(worker.alarms.get(alarmName).periodInMinutes, 1440);

    assert.deepEqual(
      await worker.send({
        type: 'REMOVE_REFRESH_TOKEN',
        integrationId: 'first',
      }),
      {
        success: true,
      }
    );
    assert.deepEqual(worker.storage.refreshEntries, { second: entry });
    assert.ok(worker.alarms.has(alarmName));
    assert.deepEqual(
      await worker.send({
        type: 'REMOVE_REFRESH_TOKEN',
        integrationId: 'second',
      }),
      {
        success: true,
      }
    );
    assert.deepEqual(worker.storage.refreshEntries, {});
    assert.equal(worker.alarms.size, 0);
  }
);

test(
  'extension restores the daily alarm and refreshes synthetic cookies on that alarm',
  { timeout: 5_000 },
  async () => {
    const worker = await startWorker({ entries: { first: entry } });
    assert.equal(worker.alarms.get(alarmName).periodInMinutes, 1440);
    await worker.fireAlarm('unrelated');
    assert.equal(worker.requests.length, 0);
    await worker.fireAlarm(alarmName);
    assert.equal(worker.requests.length, 1);
    const [{ url, options }] = worker.requests;
    assert.equal(url, entry.backendUrl + '/integrations/extension-refresh');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(options.body);
    assert.equal(body.jwt, entry.jwt);
    assert.deepEqual(
      JSON.parse(Buffer.from(body.cookies, 'base64').toString('utf8')),
      {
        client_id: 'qa-client',
        auth_token: 'qa-auth',
      }
    );

    const missingCookies = await startWorker({
      entries: { first: entry },
      cookies: [],
    });
    await missingCookies.fireAlarm(alarmName);
    assert.equal(missingCookies.requests.length, 0);
  }
);
