import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

export function localOrigin(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
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

const apiOrigin = localOrigin(
  process.env.POSTIZ_QA_API || 'http://127.0.0.1:3000'
);

export function api(path, { json, headers, ...options } = {}) {
  const url = new URL(path, apiOrigin);
  if (url.origin !== apiOrigin || !path.startsWith('/')) {
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
}

export async function createAccount() {
  const email = `postiz-qa-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('hex');
  const response = await api('/auth/register', {
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
      return api(path, { ...options, headers });
    },
  };
}
