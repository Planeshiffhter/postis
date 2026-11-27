import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAccount, openLocalDatabase } from './support.mjs';

// TEST-NET-1 is reserved for documentation. Saving these webhook settings
// performs no delivery, and the test channels are disabled fixtures.
const fixtureUrl = 'https://192.0.2.1/webhook-fixture';

async function readJson(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

test('webhook configuration requires public HTTPS and all required fields', async () => {
  const { request } = await createAccount();
  const valid = { name: 'QA validation', url: fixtureUrl, integrations: [] };
  for (const [label, json] of [
    ['insecure protocol', { ...valid, url: 'http://192.0.2.1/webhook' }],
    ['loopback destination', { ...valid, url: 'https://127.0.0.1/webhook' }],
    ['invalid URL', { ...valid, url: 'not-a-url' }],
    ['missing name', { ...valid, name: undefined }],
    ['missing integrations', { ...valid, integrations: undefined }],
  ]) {
    const response = await request('/webhooks', { method: 'POST', json });
    assert.equal(response.status, 400, label);
  }
  assert.deepEqual(await readJson(await request('/webhooks')), []);
});

test('linked webhook channels can be replaced, unlinked and deleted by their organization', async (t) => {
  const prisma = await openLocalDatabase();
  t.after(() => prisma.$disconnect());
  const owner = await createAccount();
  const other = await createAccount();
  const profile = await readJson(await owner.request('/user/self'));
  assert.equal(profile.email, owner.email);
  assert.ok(profile.orgId);
  const organizationId = profile.orgId;
  const integrationIds = [randomUUID(), randomUUID()];

  try {
    await prisma.integration.createMany({
      data: integrationIds.map((id, index) => ({
        id,
        internalId: randomUUID(),
        organizationId,
        name: `QA webhook channel ${index + 1}`,
        providerIdentifier: 'mastodon',
        type: 'social',
        token: 'qa-no-provider-credentials',
        refreshNeeded: true,
        disabled: true,
      })),
    });

    const { id } = await readJson(
      await owner.request('/webhooks', {
        method: 'POST',
        json: {
          name: 'QA linked webhook',
          url: fixtureUrl,
          integrations: [{ id: integrationIds[0] }],
        },
      }),
      201
    );
    assert.ok(id);

    async function checkLinked(name, url, ids) {
      const list = await readJson(await owner.request('/webhooks'));
      const saved = list.find((entry) => entry.id === id);
      assert.equal(saved?.name, name);
      assert.equal(saved?.url, url);
      assert.deepEqual(
        saved.integrations.map(({ integration }) => integration.id),
        ids
      );
    }

    await checkLinked('QA linked webhook', fixtureUrl, [integrationIds[0]]);
    assert.deepEqual(await readJson(await other.request('/webhooks')), []);
    const foreignDeletion = await other.request(`/webhooks/${id}`, {
      method: 'DELETE',
    });
    assert.ok(foreignDeletion.status >= 400);
    await checkLinked('QA linked webhook', fixtureUrl, [integrationIds[0]]);

    const updatedName = 'QA linked webhook updated';
    const updatedUrl = `${fixtureUrl}/updated`;
    async function update(ids) {
      return readJson(
        await owner.request('/webhooks', {
          method: 'PUT',
          json: {
            id,
            name: updatedName,
            url: updatedUrl,
            integrations: ids.map((id) => ({ id })),
          },
        })
      );
    }

    assert.deepEqual(await update([integrationIds[1]]), { id });
    await checkLinked(updatedName, updatedUrl, [integrationIds[1]]);
    assert.deepEqual(await update([]), { id });
    await checkLinked(updatedName, updatedUrl, []);

    await readJson(
      await owner.request(`/webhooks/${id}`, { method: 'DELETE' })
    );
    assert.deepEqual(await readJson(await owner.request('/webhooks')), []);
    assert.deepEqual(await readJson(await other.request('/webhooks')), []);
  } finally {
    await prisma.$transaction([
      prisma.integrationsWebhooks.deleteMany({
        where: { webhook: { organizationId } },
      }),
      prisma.webhooks.deleteMany({ where: { organizationId } }),
      prisma.integration.deleteMany({
        where: { organizationId, id: { in: integrationIds } },
      }),
    ]);
  }
});
