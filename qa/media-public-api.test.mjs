import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createAccount, localOrigin } from './support.mjs';

const frontend = localOrigin(
  process.env.POSTIZ_QA_WEB || 'http://localhost:4200'
);
const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xh5cAAAAASUVORK5CYII=',
  'base64'
);

test(
  'local media upload, search, download and delete',
  { timeout: 90_000 },
  async () => {
    const account = await createAccount();
    const upload = new FormData();
    upload.set(
      'file',
      new Blob([samplePng], { type: 'image/png' }),
      'qa-sample.png'
    );
    const create = await account.request('/media/upload-simple', {
      method: 'POST',
      body: upload,
    });
    assert.equal(create.status, 201);
    const file = await create.json();
    assert.equal(file.originalName, 'qa-sample.png');
    assert.equal(file.status, 'ready');
    assert.ok(file.id);

    try {
      const search = await account.request('/media?page=1&search=qa-sample');
      assert.equal(search.status, 200);
      assert.ok(
        (await search.json()).results.some((item) => item.id === file.id)
      );

      const url = new URL(file.path, frontend);
      assert.equal(url.origin, frontend);
      assert.match(url.pathname, /^\/uploads\//);
      const download = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-type'), /^image\/png\b/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), samplePng);
    } finally {
      const deletion = await account.request(`/media/${file.id}`, {
        method: 'DELETE',
      });
      assert.equal(deletion.status, 200);
    }

    const after = await account.request('/media?page=1&search=qa-sample');
    assert.equal(after.status, 200);
    assert.deepEqual((await after.json()).results, []);
  }
);

test(
  'public API authenticates organization keys and rejects revoked keys',
  { timeout: 45_000 },
  async () => {
    assert.equal((await api('/public/v1/me')).status, 401);
    const account = await createAccount();
    const profile = await account.request('/user/self');
    assert.equal(profile.status, 200);
    const { orgId } = await profile.json();

    async function rotate() {
      const response = await account.request('/user/api-key/rotate', {
        method: 'POST',
      });
      assert.equal(response.status, 201);
      const { apiKey } = await response.json();
      assert.ok(apiKey, 'rotation returned a key');
      return apiKey;
    }

    function getIdentity(key) {
      return api('/public/v1/me', { headers: { authorization: key } });
    }

    const initialKey = await rotate();
    const identity = await getIdentity(initialKey);
    assert.equal(identity.status, 200);
    const result = await identity.json();
    assert.equal(result.organization.id, orgId);
    assert.equal(result.user, null);

    const replacementKey = await rotate();
    assert.equal((await getIdentity(initialKey)).status, 401);
    assert.equal((await getIdentity(replacementKey)).status, 200);
  }
);
