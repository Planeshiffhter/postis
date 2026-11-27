import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { api, createAccount, openLocalDatabase } from './support.mjs';

async function readJson(response) {
  const result = await response;
  assert.equal(result.status, 200, new URL(result.url).pathname);
  return result.json();
}

test('opening notifications clears that account’s unread count and keeps other organizations separate', async (t) => {
  const database = await openLocalDatabase();
  t.after(() => database.$disconnect());
  const owner = await createAccount();
  const other = await createAccount();
  const first = await readJson(owner.request('/user/self'));
  const second = await readJson(other.request('/user/self'));
  assert.notEqual(first.orgId, second.orgId);

  const now = Date.now();
  const lastRead = new Date(now - 20_000);
  const fixtures = [
    {
      organizationId: first.orgId,
      content: 'QA notification already read',
      createdAt: new Date(now - 30_000),
    },
    {
      organizationId: first.orgId,
      content: 'QA notification unread',
      createdAt: new Date(now - 10_000),
    },
    {
      organizationId: second.orgId,
      content: 'QA notification other organization',
      createdAt: new Date(now - 5_000),
    },
  ].map((entry) => ({ id: randomUUID(), ...entry }));

  // Both accounts are disposable. Set their read marker to make the fixture
  // order independent of PostgreSQL and the API writing in the same millisecond.
  for (const [account, user] of [
    [owner, first],
    [other, second],
  ]) {
    await database.user.update({
      where: { id: user.id, email: account.email },
      data: { lastReadNotifications: lastRead },
      select: { id: true },
    });
  }
  await database.notifications.createMany({ data: fixtures });
  try {
    assert.deepEqual(await readJson(owner.request('/notifications')), {
      total: 1,
    });
    assert.deepEqual(await readJson(other.request('/notifications')), {
      total: 1,
    });

    const list = await readJson(owner.request('/notifications/list'));
    assert.equal(list.lastReadNotifications, lastRead.toISOString());
    assert.deepEqual(
      list.notifications.map(({ content }) => content),
      [fixtures[1].content, fixtures[0].content]
    );
    assert.deepEqual(await readJson(owner.request('/notifications')), {
      total: 0,
    });
    assert.deepEqual(await readJson(other.request('/notifications')), {
      total: 1,
    });

    const otherList = await readJson(other.request('/notifications/list'));
    assert.deepEqual(
      otherList.notifications.map(({ content }) => content),
      [fixtures[2].content]
    );
    assert.deepEqual(await readJson(other.request('/notifications')), {
      total: 0,
    });
  } finally {
    await database.notifications.deleteMany({
      where: { id: { in: fixtures.map(({ id }) => id) } },
    });
  }
});

test('announcements are visible to signed-in users and app-wide publishing requires an administrator', async (t) => {
  const database = await openLocalDatabase();
  t.after(() => database.$disconnect());
  const { request } = await createAccount();
  const id = randomUUID();
  const announcement = {
    title: `QA announcement ${id}`,
    description: 'Local announcement fixture',
    color: 'WARNING',
  };
  const attemptedTitle = `${announcement.title} unauthorized`;
  await database.announcement.create({ data: { id, ...announcement } });
  try {
    assert.equal((await api('/announcements')).status, 401);
    const response = await readJson(request('/announcements'));
    const saved = response.find((entry) => entry.id === id);
    assert.equal(saved?.title, announcement.title);
    assert.equal(saved?.description, announcement.description);
    assert.equal(saved?.color, announcement.color);

    const rejected = await request('/announcements', {
      method: 'POST',
      json: { ...announcement, title: attemptedTitle },
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).message, 'Unauthorized');
  } finally {
    await database.announcement.deleteMany({
      where: { OR: [{ id }, { title: attemptedTitle }] },
    });
  }
});
