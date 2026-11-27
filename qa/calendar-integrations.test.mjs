import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import { api, createAccount } from './support.mjs';

// TEST-NET-1 is reserved for documentation. These tests only save settings
// for an inactive feed and an unlinked webhook, with no requests to this URL.
const fixtureUrl = 'https://192.0.2.1/postiz-qa';

let request;
before(async () => {
  ({ request } = await createAccount());
});

async function readJson(response, status) {
  assert.equal(
    response.status,
    status,
    `${response.status} from ${response.url}`
  );
  return response.json();
}

test('calendar validates its range, lists posts, and suggests a future slot', async () => {
  const query = new URLSearchParams({
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const calendar = await readJson(await request(`/posts?${query}`), 200);
  assert.deepEqual(calendar.p, []);

  const list = await readJson(
    await request('/posts/list?page=0&limit=5&state=draft'),
    200
  );
  assert.deepEqual(list, { p: [], t: 0, pg: 0, l: 5, hm: false });

  const invalidRange = await request(
    '/posts?startDate=invalid&endDate=invalid'
  );
  assert.equal(invalidRange.status, 400);

  const slot = await readJson(await request('/posts/find-slot'), 200);
  assert.ok(
    Date.parse(`${slot.date}Z`) > Date.now(),
    'the suggested slot is in the future'
  );
});

test('tags can be created, updated, and removed from the calendar list', async () => {
  const name = `QA calendar ${randomUUID()}`;
  const { id } = await readJson(
    await request('/posts/tags', {
      method: 'POST',
      json: { name, color: '#112233' },
    }),
    201
  );
  assert.ok(id);

  try {
    const { tags } = await readJson(await request('/posts/tags'), 200);
    const created = tags.find((tag) => tag.id === id);
    assert.equal(created?.name, name);
    assert.equal(created?.color, '#112233');

    const updated = await readJson(
      await request(`/posts/tags/${id}`, {
        method: 'PUT',
        json: { name: `${name} updated`, color: '#445566' },
      }),
      200
    );
    assert.equal(updated.name, `${name} updated`);
    assert.equal(updated.color, '#445566');
  } finally {
    await readJson(
      await request(`/posts/tags/${id}`, { method: 'DELETE' }),
      200
    );
  }

  const { tags } = await readJson(await request('/posts/tags'), 200);
  assert.ok(tags.every((tag) => tag.id !== id));
});

test('provider catalog is available and an unused account has no connected channels', async () => {
  const { social, article } = await readJson(await api('/integrations'), 200);
  assert.ok(social.length > 0);
  assert.ok(social.every((provider) => provider.identifier && provider.name));
  assert.equal(
    new Set(social.map((provider) => provider.identifier)).size,
    social.length
  );
  assert.ok(Array.isArray(article));

  const channels = await readJson(await request('/integrations/list'), 200);
  assert.deepEqual(channels.integrations, []);

  const analytics = await readJson(
    await request('/analytics/post/qa-missing-post?date=7'),
    200
  );
  assert.deepEqual(analytics, []);
});

test('an inactive autopost feed can be saved and deleted', async () => {
  const feed = {
    title: 'QA inactive feed',
    url: fixtureUrl,
    lastUrl: '',
    active: false,
    onSlot: false,
    syncLast: false,
    addPicture: false,
    generateContent: false,
    integrations: [],
  };
  const { id, active } = await readJson(
    await request('/autopost', {
      method: 'POST',
      json: feed,
    }),
    201
  );
  assert.ok(id);

  try {
    assert.equal(active, false);
    const feeds = await readJson(await request('/autopost'), 200);
    const saved = feeds.find((entry) => entry.id === id);
    assert.equal(saved?.title, feed.title);
    assert.equal(saved?.url, feed.url);
    assert.equal(saved?.active, false);
  } finally {
    await readJson(await request(`/autopost/${id}`, { method: 'DELETE' }), 200);
  }

  const feeds = await readJson(await request('/autopost'), 200);
  assert.ok(feeds.every((entry) => entry.id !== id));
});

test('an unlinked webhook can be saved and deleted', async () => {
  const name = 'QA unlinked webhook';
  const { id } = await readJson(
    await request('/webhooks', {
      method: 'POST',
      json: { name, url: fixtureUrl, integrations: [] },
    }),
    201
  );
  assert.ok(id);

  try {
    const webhooks = await readJson(await request('/webhooks'), 200);
    const saved = webhooks.find((entry) => entry.id === id);
    assert.equal(saved?.name, name);
    assert.equal(saved?.url, fixtureUrl);
    assert.deepEqual(saved?.integrations, []);
  } finally {
    await readJson(await request(`/webhooks/${id}`, { method: 'DELETE' }), 200);
  }

  const webhooks = await readJson(await request('/webhooks'), 200);
  assert.ok(webhooks.every((entry) => entry.id !== id));
});
