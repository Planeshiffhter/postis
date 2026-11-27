import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalBackend } from './local-backend.mjs';
import { createAccount, localApi, openLocalDatabase } from './support.mjs';

async function json(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

test(
  'a local billing tier enables team access while reserving admin actions for owners',
  { timeout: 45_000 },
  async (t) => {
    const { origin } = await startLocalBackend(t, {
      STRIPE_PUBLISHABLE_KEY: 'pk_test_postiz_qa_fixture',
    });
    const send = localApi(origin);
    const owner = await createAccount(send);
    const member = await createAccount(send);
    const { orgId: organizationId } = await json(
      await owner.request('/user/self')
    );

    const inFreePlan = await owner.request('/settings/team');
    assert.equal(inFreePlan.status, 402);
    const freePost = await json(
      await owner.request('/posts', {
        method: 'POST',
        json: { type: 'draft', posts: [] },
      }),
      402
    );
    assert.match(freePost.message, /maximum number of posts/i);
    assert.equal(freePost.canManageBillingUi, true);

    const database = await openLocalDatabase();
    t.after(() => database.$disconnect());
    const subscription = await database.subscription.create({
      data: {
        organizationId,
        subscriptionTier: 'TEAM',
        period: 'MONTHLY',
        totalChannels: 10,
      },
      select: { id: true },
    });

    try {
      const { subscription: currentPlan } = await json(
        await owner.request('/user/subscription')
      );
      assert.equal(currentPlan.subscriptionTier, 'TEAM');

      const invitation = await json(
        await owner.request('/settings/team', {
          method: 'POST',
          json: { email: member.email, role: 'USER', sendEmail: false },
        }),
        201
      );
      const org = new URL(invitation.url).searchParams.get('org');
      assert.ok(org);
      assert.deepEqual(
        await json(
          await member.request('/user/join-org', {
            method: 'POST',
            json: { org },
          })
        ),
        { id: organizationId }
      );

      const current = await json(
        await member.request('/user/self', {
          headers: { showorg: organizationId },
        })
      );
      assert.equal(current.orgId, organizationId);
      assert.equal(current.role, 'USER');
      assert.equal(current.publicApi, '');

      const denied = await json(
        await member.request('/user/api-key/rotate', {
          method: 'POST',
          headers: { showorg: organizationId },
        }),
        402
      );
      assert.match(denied.message, /only an admin/i);
      assert.equal(denied.canManageBillingUi, false);

      const ownerRotation = await json(
        await owner.request('/user/api-key/rotate', {
          method: 'POST',
        }),
        201
      );
      assert.ok(
        ownerRotation.apiKey,
        'the owner can rotate the organization key'
      );
      const team = await json(await owner.request('/settings/team'));
      assert.ok(
        team.users.some(
          ({ user, role }) => user.email === member.email && role === 'USER'
        )
      );
    } finally {
      await database.subscription.delete({
        where: { id: subscription.id, organizationId },
      });
    }
  }
);
