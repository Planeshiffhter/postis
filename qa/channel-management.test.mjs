import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAccount, openLocalDatabase } from './support.mjs';

async function readJson(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

test('channel groups and local channel preferences can be managed', async (t) => {
  const prisma = await openLocalDatabase();
  t.after(() => prisma.$disconnect());

  const primaryName = 'QA primary group';
  const secondaryName = 'QA secondary group';
  const renamedGroup = 'QA renamed group';
  const names = [primaryName, secondaryName, renamedGroup];
  const { request, email } = await createAccount();
  const user = await readJson(await request('/user/self'));
  assert.equal(user.email, email);
  assert.ok(user.orgId);
  const organizationId = user.orgId;

  function channelFixture(name) {
    return prisma.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name,
        providerIdentifier: 'mastodon',
        type: 'social',
        token: 'qa-no-provider-credentials',
        disabled: true,
        refreshNeeded: true,
      },
      select: { id: true, name: true },
    });
  }

  const [first, second] = await prisma.$transaction([
    channelFixture('QA channel one'),
    channelFixture('QA channel two'),
  ]);

  async function listChannels() {
    const { integrations } = await readJson(
      await request('/integrations/list')
    );
    assert.deepEqual(
      new Set(integrations.map((channel) => channel.id)),
      new Set([first.id, second.id])
    );
    return Object.fromEntries(
      integrations.map((channel) => [channel.id, channel])
    );
  }

  async function setNameOrGroup(channelId, operation, data) {
    const result = await readJson(
      await request(`/integrations/${channelId}/${operation}`, {
        method: 'PUT',
        json: data,
      })
    );
    assert.deepEqual(result, { id: channelId });
  }

  try {
    await t.test(
      'create and rename channel groups, move a channel and ungroup it',
      async () => {
        await setNameOrGroup(first.id, 'customer-name', { name: primaryName });
        await setNameOrGroup(second.id, 'customer-name', {
          name: secondaryName,
        });
        const groups = await readJson(await request('/integrations/customers'));
        assert.equal(groups.length, 2);
        const primary = groups.find(({ name }) => name === primaryName);
        const secondary = groups.find(({ name }) => name === secondaryName);
        assert.ok(primary?.id && secondary?.id && primary.id !== secondary.id);

        const initial = await listChannels();
        assert.equal(initial[first.id].customer?.id, primary.id);
        assert.equal(initial[second.id].customer?.id, secondary.id);

        const duplicate = await readJson(
          await request(`/integrations/customers/${primary.id}`, {
            method: 'PUT',
            json: { name: secondaryName },
          }),
          400
        );
        assert.equal(
          duplicate.message,
          'A group with this name already exists'
        );

        const renamed = await readJson(
          await request(`/integrations/customers/${primary.id}`, {
            method: 'PUT',
            json: { name: renamedGroup },
          })
        );
        assert.equal(renamed.name, renamedGroup);

        await setNameOrGroup(second.id, 'group', { group: primary.id });
        const grouped = await listChannels();
        assert.equal(grouped[first.id].customer?.name, renamedGroup);
        assert.equal(grouped[second.id].customer?.id, primary.id);

        await setNameOrGroup(second.id, 'group', { group: '' });
        await setNameOrGroup(first.id, 'customer-name', { name: '' });
        const ungrouped = await listChannels();
        assert.equal(ungrouped[first.id].customer, null);
        assert.equal(ungrouped[second.id].customer, null);
      }
    );

    await t.test(
      'a channel display name and posting times persist on the channel list',
      async () => {
        const alias = 'QA channel alias';
        await setNameOrGroup(first.id, 'custom-name', { name: ` ${alias} ` });
        const time = [{ time: 125 }, { time: 390 }];
        assert.deepEqual(
          await readJson(
            await request(`/integrations/${first.id}/time`, {
              method: 'POST',
              json: { time },
            }),
            201
          ),
          { id: first.id }
        );

        const updated = await listChannels();
        assert.equal(updated[first.id].name, alias);
        assert.equal(updated[first.id].originalName, first.name);
        assert.deepEqual(updated[first.id].time, time);
        assert.equal(updated[second.id].name, second.name);

        await setNameOrGroup(first.id, 'custom-name', { name: '' });
        const reset = await listChannels();
        assert.equal(reset[first.id].name, first.name);
      }
    );
  } finally {
    await prisma.$transaction([
      prisma.integration.deleteMany({
        where: { organizationId, id: { in: [first.id, second.id] } },
      }),
      prisma.customer.deleteMany({
        where: { orgId: organizationId, name: { in: names } },
      }),
    ]);
  }
});
