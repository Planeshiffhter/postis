import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { startLocalBackend } from './local-backend.mjs';

test(
  'Stripe webhook routes verify signatures against the raw request body',
  { timeout: 45_000 },
  async (t) => {
    const signingKey = `whsec_${randomBytes(24).toString('hex')}`;
    const { origin } = await startLocalBackend(t, {
      STRIPE_SIGNING_KEY: signingKey,
    });
    // An unhandled event type exercises the signed path without changing
    // a subscription or calling a payment provider.
    const event = {
      id: 'evt_postiz_qa_fixture',
      type: 'postiz.qa.fixture',
      livemode: false,
      data: { object: { metadata: { service: 'gitroom' } } },
    };
    const body = JSON.stringify(event, null, 2);
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', signingKey)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const signature = `t=${timestamp},v1=${hmac}`;

    for (const path of ['/stripe', '/payment/stripe']) {
      await t.test(path, async (route) => {
        const deliver = (payload, stripeSignature) =>
          fetch(new URL(path, origin), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(stripeSignature && { 'stripe-signature': stripeSignature }),
            },
            body: payload,
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000),
          });
        for (const [label, payload, header] of [
          ['missing signature', body, undefined],
          ['invalid signature', body, `t=${timestamp},v1=${'0'.repeat(64)}`],
          ['body altered after signing', JSON.stringify(event), signature],
        ]) {
          const { status } = await deliver(payload, header);
          route.diagnostic(`${label} returned HTTP ${status}`);
          assert.ok(status >= 400, label);
        }

        const valid = await deliver(body, signature);
        assert.equal(valid.status, 201);
        assert.deepEqual(await valid.json(), { ok: true });
      });
    }
  }
);
