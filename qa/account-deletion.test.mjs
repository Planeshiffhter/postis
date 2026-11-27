import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createAccount, openLocalDatabase } from './support.mjs';

async function json(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

test(
  'deleting a local account removes its organization access and scrubs its credentials',
  { timeout: 40_000 },
  async (t) => {
    const database = await openLocalDatabase();
    t.after(() => database.$disconnect());

    const owner = await createAccount();
    const teammate = await createAccount();
    const ownerIdentity = await json(await owner.request('/user/self'));
    const teammateIdentity = await json(await teammate.request('/user/self'));
    const organizationId = ownerIdentity.orgId;
    assert.notEqual(organizationId, teammateIdentity.orgId);

    const { paymentId, subscription } =
      await database.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { paymentId: true, subscription: { select: { id: true } } },
      });
    assert.equal(paymentId, null, 'the fixture must have no billing customer');
    assert.equal(subscription, null, 'the fixture must have no subscription');

    const invitation = await json(
      await owner.request('/settings/team', {
        method: 'POST',
        json: { email: teammate.email, role: 'USER', sendEmail: false },
      }),
      201
    );
    const invite = new URL(invitation.url).searchParams.get('org');
    assert.ok(invite);
    assert.deepEqual(
      await json(
        await teammate.request('/user/join-org', {
          method: 'POST',
          json: { org: invite },
        })
      ),
      { id: organizationId }
    );
    assert.deepEqual(
      await json(await owner.request('/user/delete-account-info')),
      {
        hasSubscription: false,
        hasAdditionalMembers: true,
      }
    );

    const { apiKey } = await json(
      await owner.request('/user/api-key/rotate', { method: 'POST' }),
      201
    );
    assert.ok(apiKey);
    const organizationIdentity = () =>
      api('/public/v1/me', {
        headers: { authorization: apiKey },
      });
    assert.equal(
      (await json(await organizationIdentity())).organization.id,
      organizationId
    );

    const removed = await owner.request('/user/delete-account', {
      method: 'POST',
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.headers.get('logout'), 'true');
    assert.ok(
      removed.headers.getSetCookie().some((line) => line.startsWith('auth=;'))
    );
    assert.equal((await owner.request('/user/self')).status, 401);
    assert.equal((await organizationIdentity()).status, 401);

    const previousLogin = await api('/auth/login', {
      method: 'POST',
      json: { email: owner.email, password: owner.password, provider: 'LOCAL' },
    });
    assert.equal(previousLogin.status, 400);

    const erased = await database.user.findUniqueOrThrow({
      where: { id: ownerIdentity.id },
      select: { deletedAt: true, email: true, password: true },
    });
    assert.ok(erased.deletedAt);
    assert.ok(erased.email.startsWith('deleted_'));
    assert.notEqual(erased.email, owner.email);
    assert.equal(erased.password, null);
    const organization = await database.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { deletedAt: true },
    });
    assert.ok(organization.deletedAt);

    const organizations = await json(
      await teammate.request('/user/organizations')
    );
    assert.deepEqual(
      organizations.map(({ id }) => id),
      [teammateIdentity.orgId]
    );
    assert.equal(
      (await json(await teammate.request('/user/self'))).id,
      teammateIdentity.id
    );
  }
);
