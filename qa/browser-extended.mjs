import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createAccount, localOrigin } from './support.mjs';

const web = localOrigin(process.env.POSTIZ_QA_WEB || 'http://localhost:4200');
const api = localOrigin(process.env.POSTIZ_QA_API || 'http://localhost:3000');
const account = await createAccount();
const browser = await chromium.launch({
  executablePath: process.env.POSTIZ_QA_CHROMIUM || '/usr/bin/chromium',
});
let uploadedId;

try {
  const context = await browser.newContext({ locale: 'en-US' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return [web, api].includes(url.origin) ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    // This run blocks third-party scripts. Keep Next's development overlay
    // from intercepting clicks when those scripts cannot load.
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(style);
    });
  });
  await context.addCookies(
    account.cookie.split('; ').map((cookie) => {
      const end = cookie.indexOf('=');
      return {
        name: cookie.slice(0, end),
        value: cookie.slice(end + 1),
        url: web,
        httpOnly: true,
      };
    })
  );

  const page = await context.newPage();
  page.setDefaultTimeout(40_000);
  page.setDefaultNavigationTimeout(90_000);

  function responseFor(path, method, query = {}) {
    return page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === api &&
        url.pathname === path &&
        response.request().method() === method &&
        Object.entries(query).every(
          ([key, value]) => url.searchParams.get(key) === value
        )
      );
    });
  }

  async function navigate(label, path) {
    await Promise.all([
      page.waitForURL(new URL(path, web).href),
      page.getByRole('link', { name: label, exact: true }).click(),
    ]);
  }

  assert.equal((await page.goto(new URL('/launches', web).href)).status(), 200);
  await page.getByRole('link', { name: 'Calendar', exact: true }).waitFor();
  const monthQuery = responseFor('/posts', 'GET', { display: 'month' });
  await page.getByText('Month', { exact: true }).click();
  const month = await monthQuery;
  assert.equal(month.status(), 200);
  const dates = new URL(month.url()).searchParams;
  assert.ok(
    Date.parse(dates.get('endDate')) - Date.parse(dates.get('startDate')) >
      27 * 86_400_000,
    'the calendar sent a month-long date range'
  );

  await navigate('Media', '/media');
  await page
    .getByText("You don't have any media yet", { exact: true })
    .waitFor();
  const chooseFile = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const fileName = 'qa-chromium-sample.gif';
  const uploaded = responseFor('/media/upload-server', 'POST');
  await (
    await chooseFile
  ).setFiles({
    name: fileName,
    mimeType: 'image/gif',
    buffer: Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64'
    ),
  });
  const uploadResponse = await uploaded;
  assert.equal(uploadResponse.status(), 201);
  const file = await uploadResponse.json();
  uploadedId = file.id;
  assert.ok(uploadedId);
  assert.equal(file.originalName, fileName);

  const name = page.getByText(fileName, { exact: true });
  await name.waitFor();
  const image = page.getByAltText('media', { exact: true });
  await image.waitFor();
  assert.equal(
    await image.evaluate(async (element) => {
      await element.decode();
      return element.naturalWidth;
    }),
    1
  );
  const search = page.getByPlaceholder('Search by file name');
  await search.fill('missing-qa-chromium');
  await page
    .getByText('No media matches your search', { exact: true })
    .waitFor();
  await search.fill(fileName);
  await name.waitFor();

  await name.hover();
  await name.locator('..').locator('svg[viewBox="0 0 18 18"]').click();
  const removed = responseFor(`/media/${uploadedId}`, 'DELETE');
  await page
    .getByRole('button', { name: 'Yes, delete it!', exact: true })
    .click();
  assert.equal((await removed).status(), 200);
  uploadedId = undefined;
  await name.waitFor({ state: 'detached' });

  await navigate('Settings', '/settings');
  await page.getByRole('heading', { name: 'Global Settings' }).waitFor();
  const shortlink = page
    .locator('select')
    .filter({ has: page.locator('option[value="ASK"]') });
  const changed = responseFor('/settings/shortlink', 'POST');
  await shortlink.selectOption('NO');
  assert.equal((await changed).status(), 201);
  await page.reload();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('select')].some(
      (element) =>
        element.querySelector('option[value="ASK"]') && element.value === 'NO'
    )
  );

  await navigate('Calendar', '/launches');
  console.log(
    'Chromium verified calendar month queries, sidebar navigation, media upload/preview/search/delete, and persisted settings'
  );
} finally {
  try {
    if (uploadedId)
      await account.request(`/media/${uploadedId}`, { method: 'DELETE' });
  } finally {
    await browser.close();
  }
}
