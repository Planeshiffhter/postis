import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { api, createAccount, openLocalDatabase } from './support.mjs';

const fixturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xh5cAAAAASUVORK5CYII=',
  'base64'
);

async function readJson(response, status = 200) {
  assert.equal(response.status, status, response.url);
  return response.json();
}

async function publicApiFor(account) {
  const rotation = await account.request('/user/api-key/rotate', {
    method: 'POST',
  });
  const { apiKey } = await readJson(rotation, 201);
  assert.ok(apiKey, 'expected a fixture API key');
  return (path, options = {}) =>
    api('/public/v1' + path, {
      ...options,
      headers: { ...options.headers, authorization: apiKey },
    });
}

test(
  'the public API edits a draft in place and scopes it to its organization',
  { timeout: 45_000 },
  async (t) => {
    const database = await openLocalDatabase();
    t.after(() => database.$disconnect());
    const account = await createAccount();
    const outsider = await createAccount();
    const { orgId: organizationId } = await readJson(
      await account.request('/user/self')
    );
    const own = await publicApiFor(account);
    const other = await publicApiFor(outsider);
    const { id: integrationId } = await database.integration.create({
      data: {
        organizationId,
        internalId: randomUUID(),
        name: 'QA draft Web API',
        providerIdentifier: 'wordpress',
        type: 'social',
        token: 'qa-no-provider-credentials',
        disabled: true,
        refreshNeeded: true,
      },
      select: { id: true },
    });

    let mediaId;
    try {
      const day = 24 * 60 * 60 * 1000;
      const date = new Date(
        Math.floor((Date.now() + 2 * day) / 1000) * 1000
      ).toISOString();
      const perChannelDate = new Date(Date.now() + 8 * day).toISOString();
      const range = new URLSearchParams({
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 3 * day).toISOString(),
      });
      const listing = '/posts?' + range;

      const form = new FormData();
      form.set(
        'file',
        new Blob([fixturePng], { type: 'image/png' }),
        'qa-public-draft.png'
      );
      const media = await readJson(
        await own('/upload', { method: 'POST', body: form }),
        201
      );
      mediaId = media.id;
      assert.ok(mediaId);

      const [created] = await readJson(
        await own('/posts', {
          method: 'POST',
          json: {
            type: 'draft',
            date,
            shortLink: false,
            tags: [],
            creationMethod: 'CLI',
            posts: [
              {
                date: perChannelDate,
                integration: { id: integrationId },
                settings: {
                  title: 'QA original title',
                  type: 'posts',
                  status: 'draft',
                },
                value: [{ content: 'QA public API draft', image: [] }],
              },
            ],
          },
        }),
        201
      );
      const { postId } = created;
      assert.ok(postId);

      const original = (await readJson(await own(listing))).posts.find(
        ({ id }) => id === postId
      );
      assert.ok(original);
      assert.equal(
        original.publishDate,
        date,
        'public API uses the request-wide date'
      );
      assert.equal(original.state, 'DRAFT');
      assert.equal(original.creationMethod, 'CLI');
      assert.deepEqual((await readJson(await other(listing))).posts, []);

      const post = '/posts/' + postId;
      const foreignEdit = await other(post + '/settings', {
        method: 'PUT',
        json: { settings: { title: 'Foreign title' } },
      });
      assert.equal(foreignEdit.status, 404);

      const title = 'QA updated title';
      const settings = await readJson(
        await own(post + '/settings', {
          method: 'PUT',
          json: { settings: { title } },
        })
      );
      assert.equal(settings.postId, postId);

      const attachment = { id: media.id, path: media.path };
      const attached = await readJson(
        await own(post + '/attachments', {
          method: 'PUT',
          json: { attachments: [attachment] },
        })
      );
      assert.equal(attached.postId, postId);
      async function storedPost() {
        return database.post.findUniqueOrThrow({
          where: { id: postId, organizationId },
          select: {
            image: true,
            content: true,
            settings: true,
            publishDate: true,
            state: true,
            group: true,
          },
        });
      }
      const saved = await storedPost();
      assert.deepEqual(JSON.parse(saved.image), [attachment]);
      assert.equal(JSON.parse(saved.settings).title, title);
      assert.equal(JSON.parse(saved.settings).type, 'posts');
      assert.equal(saved.content, original.content);
      assert.equal(saved.group, original.group);
      assert.equal(saved.state, 'DRAFT');
      assert.equal(saved.publishDate.toISOString(), date);

      await readJson(
        await own(post + '/attachments', {
          method: 'PUT',
          json: { attachments: [] },
        })
      );
      assert.deepEqual(JSON.parse((await storedPost()).image), []);

      await readJson(await own(post, { method: 'DELETE' }));
      assert.ok(
        !(await readJson(await own(listing))).posts.some(
          ({ id }) => id === postId
        )
      );
    } finally {
      if (mediaId) {
        await account.request('/media/' + mediaId, { method: 'DELETE' });
      }
      await database.$transaction([
        database.post.deleteMany({ where: { organizationId, integrationId } }),
        database.integration.delete({
          where: { id: integrationId, organizationId },
        }),
      ]);
    }
  }
);
