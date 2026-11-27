import assert from 'node:assert/strict';
import test from 'node:test';
import { api, createAccount } from './support.mjs';

const appPath = '/user/oauth-app';
const callback = 'http://127.0.0.1:49152/oauth/callback';
const mcpPath = '/mcp-oauth-dynamic';

async function readJson(response, status = 200) {
  const result = await response;
  assert.equal(result.status, status, new URL(result.url).pathname);
  return result.json();
}

test('local OAuth app can be edited, authorized, revoked and deleted', async () => {
  const { request } = await createAccount();
  assert.equal(await readJson(request(appPath)), false);
  const self = await readJson(request('/user/self'));
  const draft = {
    name: 'QA OAuth app',
    description: 'Local consent check',
    redirectUrl: callback,
  };
  const app = await readJson(
    request(appPath, { method: 'POST', json: draft }),
    201
  );
  assert.ok(app.clientId);
  assert.ok(app.clientSecret, 'New app returned a client secret');

  const revision = { name: 'Updated QA OAuth app' };
  await readJson(request(appPath, { method: 'PUT', json: revision }));
  const updated = await readJson(request(appPath));
  assert.equal(updated.id, app.id);
  assert.equal(updated.name, revision.name);
  assert.equal(updated.redirectUrl, callback);
  assert.ok(
    !Object.hasOwn(updated, 'clientSecret'),
    'Reading the app hides its secret'
  );

  const rotation = await readJson(
    request(`${appPath}/rotate-secret`, { method: 'POST' }),
    201
  );
  assert.ok(
    rotation.clientSecret && rotation.clientSecret !== app.clientSecret,
    'Secret rotation returned a new secret'
  );

  const state = 'postiz-qa';
  const query = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    state,
  });
  const consent = await readJson(api(`/oauth/authorize?${query}`));
  assert.equal(consent.app.name, revision.name);
  assert.equal(consent.state, state);

  const decision = await readJson(
    request('/oauth/authorize', {
      method: 'POST',
      json: { client_id: app.clientId, action: 'approve', state },
    }),
    201
  );
  const redirect = new URL(decision.redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, callback);
  assert.equal(redirect.searchParams.get('state'), state);
  const code = redirect.searchParams.get('code');
  assert.ok(code, 'Approval returned an authorization code');

  const exchange = {
    grant_type: 'authorization_code',
    code,
    client_id: app.clientId,
    client_secret: rotation.clientSecret,
  };
  const token = await readJson(
    api('/oauth/token', { method: 'POST', body: new URLSearchParams(exchange) })
  );
  assert.equal(token.token_type, 'bearer');
  assert.ok(token.access_token, 'Exchange returned an access token');
  const { organization, user } = await readJson(
    api('/public/v1/me', {
      headers: { authorization: token.access_token },
    })
  );
  assert.equal(organization.id, self.orgId);
  assert.equal(user.id, self.id);

  const replay = await readJson(
    api('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams(exchange),
    }),
    400
  );
  assert.equal(replay.error, 'invalid_grant');
  const refresh = await readJson(
    api('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: app.clientId,
      }),
    }),
    400
  );
  assert.equal(refresh.error, 'unsupported_grant_type');

  const approved = await readJson(request('/user/approved-apps'));
  const authorization = approved.find(({ oauthApp }) => oauthApp.id === app.id);
  assert.ok(authorization, 'Approved app appears in the account');
  assert.deepEqual(
    await readJson(
      request(`/user/approved-apps/${authorization.id}`, { method: 'DELETE' })
    ),
    { success: true }
  );
  const revoked = await readJson(
    api('/public/v1/me', {
      headers: { authorization: token.access_token },
    }),
    401
  );
  assert.equal(revoked.msg, 'Invalid OAuth token');

  assert.deepEqual(await readJson(request(appPath, { method: 'DELETE' })), {
    success: true,
  });
  assert.equal(await readJson(request(appPath)), false);
});

test('MCP discovery advertises the local authorization and registration endpoints', async () => {
  const resourcePath = `/.well-known/oauth-protected-resource${mcpPath}`;
  const resource = await readJson(api(resourcePath));
  assert.equal(new URL(resource.resource).pathname, mcpPath);
  assert.equal(resource.authorization_servers.length, 1);

  const server = await readJson(
    api(`/.well-known/oauth-authorization-server${mcpPath}`)
  );
  assert.equal(server.issuer, resource.authorization_servers[0]);
  assert.equal(
    new URL(server.authorization_endpoint).pathname,
    '/oauth/authorize'
  );
  assert.equal(
    new URL(server.registration_endpoint).pathname,
    '/oauth/register'
  );
  assert.equal(new URL(server.token_endpoint).pathname, '/oauth/token');
  assert.ok(server.code_challenge_methods_supported.includes('S256'));

  const challenge = await api(mcpPath);
  assert.equal(challenge.status, 401);
  const challengeHeader = challenge.headers.get('www-authenticate');
  assert.ok(
    challengeHeader?.includes(resourcePath),
    'Challenge links to protected resource metadata'
  );
});
