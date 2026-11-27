import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { startLocalBackend } from './local-backend.mjs';
import { createAccount, localApi, openLocalDatabase } from './support.mjs';

const threadsOrigin = 'https://graph.threads.net';
const fixtureToken = 'qa-threads-token';
const externalChannelId = 'qa-threads-channel';
const externalPostId = 'qa-threads-post';
const metrics = 'views,likes,replies,reposts,quotes';

function mockThreads() {
  const network = new MockAgent();
  network.disableNetConnect();
  setGlobalDispatcher(network);

  const threads = network.get(threadsOrigin);
  const headers = { 'content-type': 'application/json' };
  threads
    .intercept({
      path(path) {
        const { pathname, searchParams } = new URL(path, threadsOrigin);
        const until = Number(searchParams.get('until'));
        const since = Number(searchParams.get('since'));
        return (
          pathname === `/v1.0/${externalChannelId}/threads_insights` &&
          searchParams.get('access_token') === fixtureToken &&
          searchParams.get('metric') === metrics &&
          searchParams.get('period') === 'day' &&
          since > 0 &&
          until > since
        );
      },
    })
    .reply(
      200,
      {
        data: [
          {
            name: 'views',
            values: [{ value: 123, end_time: '2026-01-01T12:00:00Z' }],
          },
          { name: 'likes', total_value: { value: 14 } },
        ],
      },
      { headers }
    );
  threads
    .intercept({
      path: `/v1.0/${externalPostId}/insights`,
      query: { metric: metrics, access_token: fixtureToken },
    })
    .reply(
      200,
      {
        data: [
          { name: 'views', values: [{ value: 90 }] },
          { name: 'replies', total_value: { value: 3 } },
        ],
      },
      { headers }
    );
}

if (process.env.POSTIZ_QA_THREADS_STUB === '1') {
  mockThreads();
} else {
  test(
    'Threads channel and post analytics return provider data through the API',
    { timeout: 45_000 },
    async (t) => {
      const { origin } = await startLocalBackend(t, {
        NODE_OPTIONS: `--import=${import.meta.url}`,
        POSTIZ_QA_THREADS_STUB: '1',
      });
      const prisma = await openLocalDatabase();
      t.after(() => prisma.$disconnect());

      const { email, request } = await createAccount(localApi(origin));
      async function get(path) {
        const response = await request(path);
        assert.equal(response.status, 200, path);
        return response.json();
      }

      const user = await get('/user/self');
      assert.equal(user.email, email);
      assert.ok(user.orgId);
      const organizationId = user.orgId;

      const integration = await prisma.integration.create({
        data: {
          organizationId,
          name: 'QA Threads fixture',
          type: 'social',
          providerIdentifier: 'threads',
          internalId: externalChannelId,
          token: fixtureToken,
          tokenExpiration: new Date(Date.now() + 60 * 60 * 1000),
        },
        select: { id: true },
      });
      try {
        const post = await prisma.post.create({
          data: {
            organizationId,
            integrationId: integration.id,
            group: randomUUID(),
            publishDate: new Date(),
            content: 'QA Threads analytics fixture',
            state: 'PUBLISHED',
            releaseId: externalPostId,
            releaseURL: 'https://example.invalid/qa-threads-post',
          },
          select: { id: true },
        });

        const channelPath = `/analytics/${integration.id}?date=7`;
        const [channelViews, channelLikes] = await get(channelPath);
        assert.deepEqual(channelViews, {
          label: 'Views',
          percentageChange: 5,
          data: [{ total: 123, date: '2026-01-01' }],
        });
        assert.equal(channelLikes?.label, 'Likes');
        assert.equal(channelLikes?.data[0]?.total, 14);
        assert.match(channelLikes.data[0].date, /^\d{4}-\d{2}-\d{2}$/);

        const postPath = `/analytics/post/${post.id}?date=7`;
        const postData = await get(postPath);
        assert.deepEqual(
          postData.map(({ label, percentageChange, data }) => ({
            label,
            percentageChange,
            total: data[0]?.total,
          })),
          [
            { label: 'Views', percentageChange: 0, total: '90' },
            { label: 'Replies', percentageChange: 0, total: '3' },
          ]
        );

        await prisma.integration.update({
          where: { id: integration.id, organizationId },
          data: { deletedAt: new Date() },
        });
        assert.deepEqual(await get(channelPath), []);
        assert.deepEqual(await get(postPath), []);
      } finally {
        await prisma.$transaction([
          prisma.post.deleteMany({
            where: { organizationId, integrationId: integration.id },
          }),
          prisma.integration.delete({
            where: { id: integration.id, organizationId },
          }),
        ]);
      }
    }
  );
}
