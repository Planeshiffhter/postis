import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createAccount } from './support.mjs';

async function expectStatus(response, status) {
  const result = await response;
  assert.equal(result.status, status, new URL(result.url).pathname);
  return result;
}

async function readJson(response, status = 200) {
  return (await expectStatus(response, status)).json();
}

function responseCookie(response, name) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `Expected ${name} cookie`);
  return cookie.split(';', 1)[0];
}

test('local account registration, login and logout', async () => {
  const account = await createAccount();
  const self = await readJson(account.request('/user/self'));
  assert.equal(self.email, account.email);
  assert.equal(self.role, 'SUPERADMIN');
  await expectStatus(api('/user/self'), 401);

  const credentials = {
    provider: 'LOCAL',
    email: account.email,
    password: account.password,
  };
  const rejected = await expectStatus(
    api('/auth/login', {
      method: 'POST',
      json: { ...credentials, password: `${account.password}-incorrect` },
    }),
    400
  );
  assert.equal(rejected.headers.getSetCookie().length, 0);

  const login = await expectStatus(
    api('/auth/login', {
      method: 'POST',
      json: credentials,
    }),
    200
  );
  assert.deepEqual(await login.json(), { login: true });
  const authCookie = responseCookie(login, 'auth');
  const headers = { cookie: authCookie };
  assert.equal((await readJson(api('/user/self', { headers }))).id, self.id);

  const logout = await expectStatus(
    api('/user/logout', { method: 'POST', headers }),
    200
  );
  assert.equal(logout.headers.get('logout'), 'true');
  assert.equal(responseCookie(logout, 'auth'), 'auth=');
  await expectStatus(api('/user/self', { headers: { cookie: 'auth=' } }), 401);
});

test('profile, email preferences, time zone and shortlink settings persist', async () => {
  const { request } = await createAccount();
  const profile = {
    fullname: 'Postiz QA Profile',
    bio: 'Local settings check',
  };
  await expectStatus(
    request('/user/personal', { method: 'POST', json: profile }),
    201
  );
  const savedProfile = await readJson(request('/user/personal'));
  assert.equal(savedProfile.name, profile.fullname);
  assert.equal(savedProfile.bio, profile.bio);

  const preferences = {
    sendSuccessEmails: false,
    sendFailureEmails: true,
    sendStreakEmails: false,
  };
  await expectStatus(
    request('/user/email-notifications', {
      method: 'POST',
      json: preferences,
    }),
    201
  );
  assert.deepEqual(
    await readJson(request('/user/email-notifications')),
    preferences
  );

  const timezoneName = 'America/Los_Angeles';
  await expectStatus(
    request('/user/timezone', {
      method: 'POST',
      json: { timezoneName },
    }),
    201
  );
  assert.equal(
    (await readJson(request('/user/self'))).timezoneName,
    timezoneName
  );

  await expectStatus(
    request('/settings/shortlink', {
      method: 'POST',
      json: { shortlink: 'NO' },
    }),
    201
  );
  assert.deepEqual(await readJson(request('/settings/shortlink')), {
    shortlink: 'NO',
  });
});

test('team invitation, organization selection and member removal', async () => {
  const owner = await createAccount();
  const member = await createAccount();
  const ownerIdentity = await readJson(owner.request('/user/self'));
  const memberIdentity = await readJson(member.request('/user/self'));
  const organization = ownerIdentity.orgId;
  assert.notEqual(organization, memberIdentity.orgId);

  const invitation = await readJson(
    owner.request('/settings/team', {
      method: 'POST',
      json: { email: member.email, role: 'USER', sendEmail: false },
    }),
    201
  );
  const token = new URL(invitation.url).searchParams.get('org');
  assert.ok(token, 'Expected a team invitation token');
  assert.deepEqual(
    await readJson(
      member.request('/user/join-org', {
        method: 'POST',
        json: { org: token },
      })
    ),
    { id: organization }
  );

  const team = await readJson(owner.request('/settings/team'));
  const membership = team.users.find(
    ({ user }) => user.id === memberIdentity.id
  );
  assert.equal(membership?.user.email, member.email);
  assert.equal(membership?.role, 'USER');
  const organizations = await readJson(member.request('/user/organizations'));
  assert.ok(organizations.some(({ id }) => id === organization));
  assert.ok(organizations.some(({ id }) => id === memberIdentity.orgId));

  const changeOrg = await expectStatus(
    member.request('/user/change-org', {
      method: 'POST',
      json: { id: organization },
    }),
    200
  );
  const cookie = `${member.cookie}; ${responseCookie(changeOrg, 'showorg')}`;
  const selected = await readJson(api('/user/self', { headers: { cookie } }));
  assert.equal(selected.orgId, organization);
  assert.equal(selected.role, 'USER');

  await expectStatus(
    owner.request(`/settings/team/${memberIdentity.id}`, {
      method: 'DELETE',
    }),
    200
  );
  const remaining = await readJson(owner.request('/settings/team'));
  assert.ok(!remaining.users.some(({ user }) => user.id === memberIdentity.id));
  assert.equal(
    (await readJson(api('/user/self', { headers: { cookie } }))).orgId,
    memberIdentity.orgId
  );
});

test('signatures persist and default selection follows edits', async () => {
  const { request } = await createAccount();
  const draft = { content: 'QA signature', autoAdd: true };
  const { id } = await readJson(
    request('/signatures', { method: 'POST', json: draft }),
    201
  );
  assert.ok(id);
  const defaultSignature = await readJson(request('/signatures/default'));
  assert.equal(defaultSignature.id, id);
  assert.equal(defaultSignature.content, draft.content);

  const edit = { content: 'Edited QA signature', autoAdd: false };
  await expectStatus(
    request(`/signatures/${id}`, { method: 'PUT', json: edit }),
    200
  );
  const signatures = await readJson(request('/signatures'));
  const saved = signatures.find((signature) => signature.id === id);
  assert.equal(saved?.content, edit.content);
  assert.equal(saved?.autoAdd, edit.autoAdd);
  assert.deepEqual(await readJson(request('/signatures/default')), {});

  await expectStatus(request(`/signatures/${id}`, { method: 'DELETE' }), 200);
  assert.ok(
    !(await readJson(request('/signatures'))).some(
      (signature) => signature.id === id
    )
  );
});

test('saved sets support create, edit and delete', async () => {
  const { request } = await createAccount();
  const draft = { name: 'QA set', content: 'QA saved set content' };
  const { id } = await readJson(
    request('/sets', { method: 'POST', json: draft }),
    201
  );
  assert.ok(id);
  const sets = await readJson(request('/sets'));
  const saved = sets.find((set) => set.id === id);
  assert.equal(saved?.name, draft.name);
  assert.equal(saved?.content, draft.content);

  const edit = { id, name: 'Updated QA set', content: 'Updated content' };
  await expectStatus(request('/sets', { method: 'PUT', json: edit }), 200);
  const updated = (await readJson(request('/sets'))).find(
    (set) => set.id === id
  );
  assert.equal(updated?.name, edit.name);
  assert.equal(updated?.content, edit.content);

  await expectStatus(request(`/sets/${id}`, { method: 'DELETE' }), 200);
  assert.ok(!(await readJson(request('/sets'))).some((set) => set.id === id));
});
