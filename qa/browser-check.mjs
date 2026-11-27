import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createAccount } from './support.mjs';

const account = await createAccount();
const browser = await chromium.launch({
  executablePath: process.env.POSTIZ_QA_CHROMIUM || '/usr/bin/chromium',
});
try {
  const context = await browser.newContext();
  await context.route('**/*', async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      await route.continue();
      return;
    }
    await route.abort();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  await page.goto('http://localhost:4200/auth/login', { timeout: 90_000 });
  assert.equal(await page.title(), 'Postiz Login');
  await page.locator('input[type=email]').fill(account.email);
  await page.locator('input[type=password]').fill(account.password);
  const loginStatus = page.waitForResponse(
    (response) =>
      response.url() === 'http://localhost:3000/auth/login' &&
      response.request().method() === 'POST'
  );
  const postLoginNavigation = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame(),
  });
  await page.getByRole('button', { name: /^sign in$/i }).click();
  assert.equal((await loginStatus).status(), 200);
  await postLoginNavigation;
  assert.ok((await context.cookies()).some(({ name }) => name === 'auth'));

  const pages = [
    ['/launches', 'Postiz Calendar'],
    ['/media', 'Postiz Media'],
    ['/settings', 'Postiz Settings'],
    ['/analytics', 'Postiz Analytics'],
  ];
  for (const [path, title] of pages) {
    const response = await page.goto('http://localhost:4200' + path, {
      timeout: 90_000,
    });
    assert.equal(response.status(), 200);
    assert.equal(new URL(page.url()).pathname, path);
    await page.waitForFunction(
      (expected) => document.title === expected,
      title
    );
  }

  await page.goto('http://localhost:4200/auth/logout');
  await page.waitForURL('**/auth/login');
  console.log(
    'Chromium verified login, calendar, media, settings, analytics, and logout'
  );
} finally {
  await browser.close();
}
