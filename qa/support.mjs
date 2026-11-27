import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const loopback = ['127.0.0.1', 'localhost', '[::1]'];

export function localOrigin(value) {
  const url = new URL(value);
  if (
    !loopback.includes(url.hostname) ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'QA requires a local HTTP origin with no credentials or path'
    );
  }
  return url.origin;
}

export async function openLocalDatabase() {
  const { PrismaClient } = await import('@prisma/client');
  const { parse } = await import('dotenv');
  const envFile = new URL('../.env', import.meta.url);
  const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
  const datasourceUrl = process.env.DATABASE_URL || settings.DATABASE_URL;
  let database;
  try {
    database = new URL(datasourceUrl);
  } catch {
    assert.fail('DATABASE_URL must be a local PostgreSQL URL');
  }
  assert.ok(
    ['postgresql:', 'postgres:'].includes(database.protocol) &&
      loopback.includes(database.hostname) &&
      !database.searchParams.has('host') &&
      !database.searchParams.has('hostaddr'),
    'DATABASE_URL must use loopback PostgreSQL'
  );
  return new PrismaClient({ datasourceUrl });
}

export function localApi(value) {
  const origin = localOrigin(value);
  return (path, { json, headers, ...options } = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || !path.startsWith('/')) {
      throw new Error('QA requires a local API path');
    }
    const requestHeaders = new Headers(headers);
    if (json !== undefined) {
      requestHeaders.set('content-type', 'application/json');
      options.body = JSON.stringify(json);
    }
    return fetch(url, {
      signal: AbortSignal.timeout(20_000),
      ...options,
      redirect: 'manual',
      headers: requestHeaders,
    });
  };
}

export const api = localApi(
  process.env.POSTIZ_QA_API || 'http://127.0.0.1:3000'
);

export async function createAccount(send = api) {
  const email = `postiz-qa-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('hex');
  const response = await send('/auth/register', {
    method: 'POST',
    json: { email, company: 'Postiz QA', password, provider: 'LOCAL' },
  });
  assert.equal(response.status, 200, 'local registration status');
  assert.deepEqual(await response.json(), { register: true });
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';', 1)[0])
    .filter((entry) => /^(auth|showorg)=/.test(entry))
    .join('; ');
  assert.ok(
    cookie.includes('auth='),
    'local registration set a session cookie'
  );

  return {
    cookie,
    email,
    password,
    request(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set('cookie', cookie);
      return send(path, { ...options, headers });
    },
  };
}
