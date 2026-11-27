import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { api, createAccount, localOrigin } from './support.mjs';

const origin = localOrigin(
  process.env.POSTIZ_QA_API || 'http://127.0.0.1:3000'
);

test(
  'MCP authenticates clients, executes local tools, and exposes the upload widget',
  { timeout: 60_000 },
  async (t) => {
    const withoutKey = await api('/mcp', { method: 'POST', json: {} });
    assert.equal(withoutKey.status, 401);

    const { request } = await createAccount();
    const rotation = await request('/user/api-key/rotate', { method: 'POST' });
    assert.equal(rotation.status, 201);
    const { apiKey } = await rotation.json();
    assert.ok(apiKey, 'rotation returned an organization key');

    const endpoint = new URL('/mcp', origin);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: { authorization: 'Bearer ' + apiKey },
        redirect: 'manual',
      },
    });
    const client = new Client({ name: 'Postiz QA', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'Postiz MCP');

    const { tools } = await client.listTools();
    const integrationList = tools.find(
      ({ name }) => name === 'integrationList'
    );
    assert.equal(integrationList?.annotations?.readOnlyHint, true);
    const list = await client.callTool({
      name: 'integrationList',
      arguments: {},
    });
    assert.equal(list.isError, false);
    assert.deepEqual(list.structuredContent, { output: [] });

    const groupList = await client.callTool({
      name: 'groupList',
      arguments: {},
    });
    assert.equal(groupList.isError, false);
    assert.deepEqual(groupList.structuredContent, { output: [] });

    const widget = 'ui://postiz/upload';
    const { resources } = await client.listResources();
    assert.ok(resources.some(({ uri }) => uri === widget));
    const { contents } = await client.readResource({ uri: widget });
    const mediaResource = contents.find(({ uri }) => uri === widget);
    assert.match(mediaResource?.mimeType || '', /^text\/html\b/);
    assert.match(mediaResource?.text || '', /upload/i);

    const catalog = await api('/integrations');
    assert.equal(catalog.status, 200);
    const { social } = await catalog.json();
    assert.ok(social.length > 0, 'catalog contains social providers');
    for (const { identifier } of social) {
      await t.test(`posting schema for ${identifier}`, async () => {
        const result = await client.callTool({
          name: 'integrationSchema',
          arguments: { platform: identifier, isPremium: false },
        });
        assert.equal(result.isError, false);
        const {
          rules,
          maxLength,
          settings,
          tools: providerTools,
        } = result.structuredContent.output;
        assert.equal(typeof rules, 'string');
        assert.ok(maxLength > 0);
        assert.ok(settings);
        assert.ok(Array.isArray(providerTools));
      });
    }
  }
);
