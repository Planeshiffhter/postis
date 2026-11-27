import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const host = '127.0.0.1';
export const fixtureFrontend = `http://${host}:4200`;

export async function listenLoopback(server) {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

function localDependency(value, protocols, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail(`${label} must use a local address`);
  }
  assert.ok(
    protocols.includes(url.protocol) &&
      [host, 'localhost', '[::1]'].includes(url.hostname) &&
      !url.searchParams.has('host') &&
      !url.searchParams.has('hostaddr'),
    `${label} must use a loopback host`
  );
  return url;
}

export async function startLocalBackend(t, fixtureEnvironment) {
  const reserved = createServer();
  const port = await listenLoopback(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  const origin = `http://${host}:${port}`;
  const backend = new URL('../apps/backend/', import.meta.url);
  const entry = new URL('dist/apps/backend/src/main.js', backend);
  assert.ok(
    existsSync(entry),
    'Build the backend before running isolated API checks'
  );

  const envFile = new URL('../.env', import.meta.url);
  const settings = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
  const database = process.env.DATABASE_URL || settings.DATABASE_URL;
  const redis =
    process.env.REDIS_URL || settings.REDIS_URL || `redis://${host}:6379`;
  const temporal =
    process.env.TEMPORAL_ADDRESS || settings.TEMPORAL_ADDRESS || `${host}:7233`;
  localDependency(database, ['postgres:', 'postgresql:'], 'DATABASE_URL');
  localDependency(redis, ['redis:', 'rediss:'], 'REDIS_URL');
  const temporalUrl = localDependency(
    `http://${temporal}`,
    ['http:'],
    'TEMPORAL_ADDRESS'
  );
  assert.ok(
    temporalUrl.port && temporalUrl.host === temporal,
    'TEMPORAL_ADDRESS must be a host and port'
  );

  const uploads = mkdtempSync(join(tmpdir(), 'postiz-qa-api-'));
  const child = spawn(
    process.execPath,
    ['--experimental-require-module', fileURLToPath(entry)],
    {
      cwd: fileURLToPath(backend),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...fixtureEnvironment,
        PATH: process.env.PATH,
        DATABASE_URL: database,
        REDIS_URL: redis,
        TEMPORAL_ADDRESS: temporal,
        TEMPORAL_NAMESPACE:
          process.env.TEMPORAL_NAMESPACE ||
          settings.TEMPORAL_NAMESPACE ||
          'default',
        PORT: String(port),
        MAIN_URL: fixtureFrontend,
        FRONTEND_URL: fixtureFrontend,
        NEXT_PUBLIC_BACKEND_URL: origin,
        BACKEND_INTERNAL_URL: origin,
        STORAGE_PROVIDER: 'local',
        UPLOAD_DIRECTORY: uploads,
        NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: 'uploads',
        IS_GENERAL: 'true',
        JWT_SECRET: randomBytes(32).toString('hex'),
      },
    }
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  let spawnError;
  let listening = false;
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    if (line === `Backend started successfully on port ${port}`)
      listening = true;
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  t.after(async () => {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await closed;
    clearTimeout(timeout);
    rmSync(uploads, { recursive: true, force: true });
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'Isolated API exited during startup');
    if (listening) {
      const response = await fetch(origin, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      if (response?.ok && (await response.text()) === 'App is running!') {
        return { origin, uploads };
      }
    }
    await delay(150);
  }
  assert.fail('The isolated API did not start');
}
