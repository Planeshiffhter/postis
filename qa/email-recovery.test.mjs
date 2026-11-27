import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import {
  fixtureFrontend,
  listenLoopback,
  startLocalBackend,
} from './local-backend.mjs';

const smtpUser = 'postiz-qa';
const smtpPassword = 'local-smtp-fixture';

async function captureMail(t) {
  const messages = [];
  const sockets = new Set();
  const credentials = Buffer.from(`\0${smtpUser}\0${smtpPassword}`).toString(
    'base64'
  );
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const reply = (message) => socket.write(`${message}\r\n`);
    let recipient;
    let content;
    reply('220 localhost Postiz QA');

    lines.on('line', (line) => {
      if (content) {
        if (line === '.') {
          messages.push({ recipient, body: content.join('\r\n') });
          content = undefined;
          reply('250 Message captured');
        } else {
          content.push(line.startsWith('..') ? line.slice(1) : line);
        }
        return;
      }

      switch (line.split(' ', 1)[0].toUpperCase()) {
        case 'EHLO':
          reply('250-localhost\r\n250 AUTH PLAIN');
          break;
        case 'AUTH':
          reply(
            line === `AUTH PLAIN ${credentials}`
              ? '235 Authenticated'
              : '535 Invalid credentials'
          );
          break;
        case 'MAIL':
          recipient = undefined;
          reply('250 Sender accepted');
          break;
        case 'RCPT':
          recipient = /^RCPT TO:<([^>]+)>/i.exec(line)?.[1];
          reply(
            recipient?.endsWith('@example.invalid')
              ? '250 Recipient accepted'
              : '550 QA recipient required'
          );
          break;
        case 'DATA':
          content = [];
          reply('354 End with a dot');
          break;
        case 'QUIT':
          socket.end('221 Closing\r\n');
          break;
        default:
          reply('502 Command not supported');
      }
    });
  });

  const port = await listenLoopback(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { messages, port };
}

function mailToken(message, email, subject, route) {
  assert.equal(
    message?.recipient,
    email,
    'The fixture captured mail for the test account'
  );
  assert.equal(/^Subject: (.+)$/m.exec(message.body)?.[1], subject);
  const decoded = message.body
    .replace(/=\r?\n/g, '')
    .replace(/=([\dA-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  const link = [...decoded.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .find((url) => url.startsWith(`${fixtureFrontend}${route}`));
  const token = link?.slice(fixtureFrontend.length + route.length);
  assert.ok(token, 'The captured mail contains its account link');
  return token;
}

test(
  'local SMTP delivers activation and password recovery links that work',
  { timeout: 45_000 },
  async (t) => {
    const { messages, port } = await captureMail(t);
    const { origin } = await startLocalBackend(t, {
      EMAIL_PROVIDER: 'nodemailer',
      EMAIL_HOST: '127.0.0.1',
      EMAIL_PORT: String(port),
      EMAIL_SECURE: 'false',
      EMAIL_USER: smtpUser,
      EMAIL_PASS: smtpPassword,
      EMAIL_FROM_ADDRESS: 'postiz@example.invalid',
      EMAIL_FROM_NAME: 'Postiz QA',
    });
    const email = `postiz-qa-${randomUUID()}@example.invalid`;
    const password = randomBytes(20).toString('hex');
    const provider = 'LOCAL';
    const post = (path, json) =>
      fetch(new URL(path, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });

    const registered = await post('/auth/register', {
      email,
      password,
      provider,
      company: 'Postiz Email QA',
    });
    assert.equal(registered.status, 200);
    assert.deepEqual(await registered.json(), { activate: true });
    assert.equal(registered.headers.getSetCookie().length, 0);
    mailToken(messages[0], email, 'Activate your account', '/auth/activate/');
    assert.equal(
      (await post('/auth/login', { email, password, provider })).status,
      400
    );

    const resent = await post('/auth/resend-activation', { email });
    assert.equal(resent.status, 201);
    assert.deepEqual(await resent.json(), { success: true });
    const code = mailToken(
      messages[1],
      email,
      'Activate your account',
      '/auth/activate/'
    );
    const activated = await post('/auth/activate', { code });
    assert.equal(activated.status, 200);
    assert.deepEqual(await activated.json(), { can: true });
    assert.ok(
      activated.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('auth='))
    );

    const forgot = await post('/auth/forgot', { email });
    assert.equal(forgot.status, 201);
    assert.deepEqual(await forgot.json(), { forgot: true });
    const token = mailToken(
      messages[2],
      email,
      'Reset your password',
      '/auth/forgot/'
    );
    const replacement = randomBytes(20).toString('hex');
    const reset = await post('/auth/forgot-return', {
      password: replacement,
      repeatPassword: replacement,
      token,
    });
    assert.equal(reset.status, 201);
    assert.deepEqual(await reset.json(), { reset: true });

    const previous = await post('/auth/login', { email, password, provider });
    assert.equal(previous.status, 400);
    const login = await post('/auth/login', {
      email,
      password: replacement,
      provider,
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { login: true });
  }
);
