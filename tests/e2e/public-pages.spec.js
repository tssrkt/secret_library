import { test, expect } from '@playwright/test';

const AUTH_MODULE = '/js/auth.js?v=20261114-brave-oauth2-redirect';
const UI_MODULE = '/js/ui.js?v=20261115-friends-invitations-pagination';
const SOCIAL_MODULE = '/js/social-runtime.js?v=20261117-notification-events';

async function mockGoogleIdentity(page, behavior = 'error') {
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `
      window.__oauthCalls = [];
      window.google = { accounts: { oauth2: {
        initTokenClient(config) {
          const client = {
            callback: config.callback,
            error_callback: config.error_callback,
            requestAccessToken(options) {
              window.__oauthCalls.push(options);
              if (${JSON.stringify(behavior)} === 'error') {
                setTimeout(() => client.error_callback?.({ type: 'popup_failed_to_open' }), 0);
              }
            }
          };
          return client;
        },
        revoke(_token, callback) { callback?.({ successful: true }); }
      } } };
    `,
  }));
}

async function mockDriveApi(page, { failFolderPatch = false } = {}) {
  const calls = [];
  let folderAccessDisabled = false;
  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    calls.push({ method, pathname: url.pathname, search: url.search, body: request.postData() || '' });

    if (url.pathname === '/drive/v3/files' && method === 'GET' && url.searchParams.get('spaces') === 'appDataFolder') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    }
    if (url.pathname === '/drive/v3/files/folder-a' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'folder-a',
        name: 'Фантастика',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        inheritedPermissionsDisabled: folderAccessDisabled,
        capabilities: { canDisableInheritedPermissions: true, canEnableInheritedPermissions: true },
      }) });
    }
    if (url.pathname === '/drive/v3/files/folder-a' && method === 'PATCH') {
      if (failFolderPatch) {
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
          error: { message: 'Test-only permission denied' },
        }) });
      }
      const next = JSON.parse(request.postData() || '{}').inheritedPermissionsDisabled;
      folderAccessDisabled = next === true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'folder-a', inheritedPermissionsDisabled: folderAccessDisabled,
      }) });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'settings-id' }) });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Unexpected request in isolated E2E test' } }),
    });
  });
  return calls;
}

async function mountLibraryInBrowser(page, { friend = false } = {}) {
  await page.evaluate(async ({ authModule, uiModule, socialModule, friend }) => {
    const auth = await import(authModule);
    sessionStorage.setItem(auth.AUTH_SESSION_KEY, JSON.stringify({
      accessToken: 'isolated-e2e-token',
      expiresAt: Date.now() + 3_600_000,
      user: { displayName: 'E2E Owner', emailAddress: 'owner@example.test' },
    }));
    auth.restoreAuthSession();

    const ui = await import(uiModule);
    // Import the exact versioned module URL used by app.js. A second UI module
    // instance would attach duplicate dropdown listeners and toggle the menu twice.
    ui.setAuthorized(true);

    const index = {
      version: 4,
      rootFolderId: 'root',
      folders: [
        { id: 'root', parentId: null, name: 'Библиотека' },
        { id: 'folder-a', parentId: 'root', name: 'Фантастика' },
      ],
      books: [
        {
          id: 'book-root',
          parentId: 'root',
          title: 'Книга для браузерного теста',
          authors: ['Автор теста'],
          genres: ['sf'],
          fileName: 'test.fb2',
          modifiedTime: 'e2e-v1',
          metadataStatus: 'ready',
          metadataVersion: 3,
        },
        {
          id: 'book-folder',
          parentId: 'folder-a',
          title: 'Книга в папке',
          authors: ['Другой автор'],
          fileName: 'folder.fb2',
          metadataStatus: 'ready',
          metadataVersion: 3,
        },
      ],
    };

    if (friend) {
      const social = (await import(socialModule)).social;
      window.__coverCalls = [];
      window.__restoreCoverLoader = social.loadCover;
      social.loadCover = async (ownerId, book) => {
        window.__coverCalls.push({ ownerId, bookId: book.id });
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ioAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
        return new Blob([bytes], { type: 'image/png' });
      };
    }

    ui.renderLibrary(index, async () => {}, friend ? { readOnly: true, ownerId: 'friend-uid' } : {});
  }, { authModule: AUTH_MODULE, uiModule: UI_MODULE, socialModule: SOCIAL_MODULE, friend });
}

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

  await mockGoogleIdentity(page);
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeVisible();
  await expect(page.locator('#status-panel')).toBeVisible();
  await expect(page.locator('#library-home-link')).toHaveAttribute('href', './index.html');
  await expect(page.locator('#user-controls')).toBeHidden();
  await expect(page.locator('#sign-in-button')).toBeEnabled();

  expect(pageErrors, 'uncaught browser errors').toEqual([]);
  expect(localFailures, 'failed local assets').toEqual([]);
});

test('Google sign-in failure is shown in the page and the user can retry', async ({ page }) => {
  await mockGoogleIdentity(page);
  await page.goto('/');
  const button = page.locator('#sign-in-button');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('#error-panel')).toBeVisible({ timeout: 7_000 });
  await expect(page.locator('#error-text')).toContainText(/Google OAuth|popup error|Google/);
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => window.__oauthCalls?.length)).toBe(1);
  await button.click();
  await expect.poll(() => page.evaluate(() => window.__oauthCalls?.length)).toBe(2);
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('secret-library-google-session-v2'))).toBeNull();
  await expect(page.locator('#user-controls')).toBeHidden();
});

test('real library UI supports author filtering, opening book details, and returning home', async ({ page }) => {
  await mockGoogleIdentity(page);
  await mockDriveApi(page);
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeEnabled();
  await mountLibraryInBrowser(page);

  await expect(page.locator('#library-panel')).toBeVisible();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.book-author-link').click();
  await expect(page.locator('.direct-results-title')).toBeVisible();
  await expect(page.locator('.direct-results-title')).toContainText('Автор теста');
  await page.locator('.book-card-title').click();
  await expect(page.locator('#annotation-modal')).toBeVisible();
  await expect(page.locator('#annotation-modal-title')).toContainText('Книга для браузерного теста');
  await page.locator('#annotation-modal-close').click();
  await expect(page.locator('#annotation-modal')).toBeHidden();

  await page.locator('#library-home-link').click();
  await expect(page.locator('.direct-results-title')).toHaveCount(0);
  await expect(page.locator('#annotation-modal')).toBeHidden();
  await expect(page.locator('.tree-list')).toBeVisible();
});

test('settings save applies a folder access change and records only expected Drive requests', async ({ page }) => {
  const calls = await mockDriveApi(page);
  await mockGoogleIdentity(page);
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeEnabled();
  await mountLibraryInBrowser(page);

  await page.locator('#avatar-button').click();
  await expect(page.locator('#avatar-menu')).toBeVisible();
  await page.locator('#settings-button').click();
  await expect(page.locator('.sharing-folders-section')).toBeVisible();
  const checkbox = page.locator('.sharing-folders-section input[type="checkbox"]').first();
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.locator('.sharing-settings-form [type="submit"]').click();
  await expect(page.locator('.sharing-folders-section > p[role="status"]')).toContainText('Настройки сохранены.');

  expect(calls.some((call) => call.method === 'PATCH' && call.pathname === '/drive/v3/files/folder-a' && call.body.includes('"inheritedPermissionsDisabled":true')),
    'unchecked folder must be made private through the folder API').toBeTruthy();
  expect(calls.some((call) => call.method === 'POST' && call.pathname === '/upload/drive/v3/files'),
    'settings must be persisted through the app-data upload path').toBeTruthy();
  expect(calls.some((call) => call.search.includes('spaces=drive') || call.pathname.includes('/permissions')),
    'settings save must not scan all Drive files or enumerate permissions').toBeFalsy();
  expect(calls.some((call) => call.method === 'DELETE'), 'tests must not delete Drive files').toBeFalsy();
});

test('failed folder access update restores the checkbox and shows a user-facing error', async ({ page }) => {
  await mockDriveApi(page, { failFolderPatch: true });
  await mockGoogleIdentity(page);
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeEnabled();
  await mountLibraryInBrowser(page);

  await page.locator('#avatar-button').click();
  await page.locator('#settings-button').click();
  const checkbox = page.locator('.sharing-folders-section input[type="checkbox"]').first();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.locator('.sharing-settings-form [type="submit"]').click();

  await expect(page.locator('#error-panel')).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('.sharing-folders-section > p[role="status"]')).not.toContainText('Настройки сохранены.');
  const message = await page.locator('#error-text').innerText();
  expect(message).not.toMatch(/Firestore|Firebase|database|internal|stack|https:\/\//i);
});

test('friend library cover uses the shared social loader and appears as an image in the browser', async ({ page }) => {
  await mockGoogleIdentity(page);
  await mockDriveApi(page);
  await page.goto('/');
  await expect(page.locator('#sign-in-button')).toBeEnabled();
  await mountLibraryInBrowser(page, { friend: true });

  await expect(page.locator('body')).toHaveClass(/viewing-friend-library/);
  await expect(page.locator('#library-panel')).toHaveClass(/friend-library/);
  await expect(page.locator('.folder-note-edit')).toHaveCount(0);

  const cover = page.locator('.book-cover-image');
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute('alt', 'Обложка: Книга для браузерного теста');
  await expect.poll(() => page.evaluate(() => window.__coverCalls)).toContainEqual({ ownerId: 'friend-uid', bookId: 'book-root' });
  await expect(page.locator('.book-card')).toHaveCount(1);

  await page.evaluate(async (socialModule) => {
    const social = (await import(socialModule)).social;
    if (window.__restoreCoverLoader) social.loadCover = window.__restoreCoverLoader;
  }, SOCIAL_MODULE);
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
