import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  api,
  createAccount,
  localOrigin,
  openLocalDatabase,
} from './support.mjs';

const frontend = localOrigin(
  process.env.POSTIZ_QA_WEB || 'http://localhost:4200'
);

test(
  'a public draft preview supports anchored comments, replies, and owner resolution',
  { timeout: 110_000 },
  async (t) => {
    const database = await openLocalDatabase();
    t.after(() => database.$disconnect());

    const owner = await createAccount();
    const outsider = await createAccount();
    const self = await owner.request('/user/self');
    assert.equal(self.status, 200);
    const { orgId: organizationId } = await self.json();
    assert.ok(organizationId);

    const { id: integrationId } = await database.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name: 'QA preview channel',
        providerIdentifier: 'mastodon',
        type: 'social',
        token: 'qa-no-provider-credentials',
        disabled: true,
        refreshNeeded: true,
      },
      select: { id: true },
    });

    try {
      const draft = await database.post.create({
        data: {
          organizationId,
          integrationId,
          group: randomUUID(),
          state: 'DRAFT',
          publishDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          content: '<p>Review the draft</p>',
          settings: JSON.stringify({ __type: 'mastodon' }),
          image: '[]',
        },
        select: { id: true },
      });
      const preview = '/public/posts/' + draft.id;
      const response = await api(preview);
      assert.equal(response.status, 200);
      const [post] = await response.json();
      assert.equal(post.id, draft.id);
      assert.equal(post.integration.name, 'QA preview channel');
      assert.equal('token' in post.integration, false);

      const page = await fetch(new URL('/p/' + draft.id, frontend), {
        redirect: 'manual',
        signal: AbortSignal.timeout(80_000),
      });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>Postiz Preview<\/title>/);

      const comments = preview + '/comments';
      const invalidAnchor = await api(comments, {
        method: 'POST',
        json: {
          content: 'The quote must match',
          displayName: 'QA Guest',
          anchorStart: 0,
          anchorEnd: 6,
          anchorQuote: 'wrong!',
        },
      });
      assert.equal(invalidAnchor.status, 400);

      const guest = await api(comments, {
        method: 'POST',
        json: {
          content: 'Please clarify this wording',
          displayName: 'QA Guest',
          anchorStart: 0,
          anchorEnd: 6,
          anchorQuote: 'Review',
        },
      });
      assert.equal(guest.status, 201);
      const { id: commentId } = await guest.json();
      assert.ok(commentId);

      const reply = await owner.request('/posts/' + draft.id + '/comments', {
        method: 'POST',
        json: { content: 'Thanks for reviewing', parentId: commentId },
      });
      assert.equal(reply.status, 201);
      const { id: replyId } = await reply.json();

      const resolvePath = '/posts/comments/' + commentId + '/resolve';
      const outsiderResolution = await outsider.request(resolvePath, {
        method: 'PUT',
        json: { resolved: true },
      });
      assert.equal(outsiderResolution.status, 404);

      const resolution = await owner.request(resolvePath, {
        method: 'PUT',
        json: { resolved: true },
      });
      assert.equal(resolution.status, 200);

      const list = await api(comments);
      assert.equal(list.status, 200);
      const { comments: entries } = await list.json();
      const root = entries.find(({ id }) => id === commentId);
      assert.equal(root?.name, 'QA Guest');
      assert.equal(root?.anchorQuote, 'Review');
      assert.ok(root?.resolvedAt);
      assert.equal(
        entries.find(({ id }) => id === replyId)?.parentId,
        commentId
      );

      const reopen = await owner.request(resolvePath, {
        method: 'PUT',
        json: { resolved: false },
      });
      assert.equal(reopen.status, 200);
      const reopened = await api(comments);
      assert.equal(reopened.status, 200);
      assert.equal(
        (await reopened.json()).comments.find(({ id }) => id === commentId)
          ?.resolvedAt,
        null
      );
    } finally {
      await database.$transaction([
        database.comments.deleteMany({
          where: { organizationId, post: { integrationId } },
        }),
        database.post.deleteMany({ where: { organizationId, integrationId } }),
        database.integration.delete({
          where: { id: integrationId, organizationId },
        }),
      ]);
    }
  }
);
