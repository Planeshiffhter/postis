import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAccount } from './support.mjs';

test('optional capabilities in unconfigured local development', async (t) => {
  const account = await createAccount();

  await t.test(
    'AI and clipping credit balances and video catalog',
    async () => {
      for (const type of ['ai_images', 'ai_videos', 'clipping_minutes']) {
        const response = await account.request(`/copilot/credits?type=${type}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { credits: 0 });
      }

      const videos = await account.request('/media/video-options');
      assert.equal(videos.status, 200);
      assert.deepEqual(await videos.json(), []);
    }
  );

  await t.test(
    'clipping list, missing clip and unavailable processor',
    async () => {
      const list = await account.request('/clipping?page=1');
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), { pages: 0, results: [] });

      const missing = await account.request(`/clipping/${randomUUID()}`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).message, 'Clipping not found');

      // This URL cannot create a job even if a processor is configured.
      const unavailable = await account.request('/clipping', {
        method: 'POST',
        json: { url: 'https://example.invalid/qa-clip' },
      });
      assert.equal(unavailable.status, 503);
      assert.equal(
        (await unavailable.json()).message,
        'Clipping is not available'
      );
    }
  );

  await t.test(
    'cloud media metadata rejects an invalid object name',
    async () => {
      const invalid = await account.request('/media/save-media', {
        method: 'POST',
        json: { name: '../qa-sample.png', originalName: 'qa-sample.png' },
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).message, 'Invalid file name');
    }
  );

  await t.test('billing has no subscription or completed trial', async () => {
    const subscription = await account.request('/user/subscription');
    assert.equal(subscription.status, 200);
    assert.deepEqual(await subscription.json(), {});

    const trial = await account.request('/billing/is-trial-finished');
    assert.equal(trial.status, 200);
    assert.deepEqual(await trial.json(), { finished: false });
  });

  await t.test('third-party catalog and empty connected services', async () => {
    const catalog = await account.request('/third-party/list');
    assert.equal(catalog.status, 200);
    const providers = await catalog.json();
    assert.ok(providers.some(({ identifier }) => identifier === 'heygen'));
    assert.ok(providers.some(({ identifier }) => identifier === 'reelfarm'));

    const connected = await account.request('/third-party');
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), []);
  });
});
