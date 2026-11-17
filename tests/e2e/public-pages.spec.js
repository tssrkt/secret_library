import { test, expect } from '@playwright/test';

test('home page boots and exposes the expected signed-out controls', async ({ page }) => {
  const pageErrors = [];
  const localFailures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('http://127.0.0.1:4173/')) {
      localFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().startsWith('http://127.0.0.1:4173/') && response.status() >= 400) {
      localFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.locator('#status-panel')).toBeVisible();
  await expect(page.locator('#library-home-link')).toHaveAttribute('href', './index.html');
  await expect(page.locator('#user-controls')).toBeHidden();

  expect(pageErrors, 'uncaught browser errors').toEqual([]);
  expect(localFailures, 'failed local assets').toEqual([]);
});

test('public information and privacy pages load', async ({ page }) => {
  for (const path of ['/info.html', '/privacy.html']) {
    const response = await page.goto(path);
    expect(response, `response for ${path}`).not.toBeNull();
    expect(response.status(), `HTTP status for ${path}`).toBe(200);
    await expect(page.locator('body')).not.toBeEmpty();
    expect((await page.title()).trim().length, `non-empty title for ${path}`).toBeGreaterThan(0);
  }
});

test('local browser server does not expose project metadata or tests', async ({ request }) => {
  for (const path of [
    '/.ua/knowledge-graph.json',
    '/package.json',
    '/package-lock.json',
    '/tests/e2e/public-pages.spec.js',
    '/functions/package.json',
  ]) {
    const response = await request.get(path);
    expect(response.status(), `private path ${path}`).toBe(404);
  }
});
