# Drive scope reduction and Google Picker setup

This branch replaces the broad `drive` OAuth scope with `drive.readonly`, `drive.appdata`, and `drive.file`.

## Required one-time Google Cloud setup

1. Open the [Google Picker API](https://console.cloud.google.com/apis/library/picker.googleapis.com) page in the same Google Cloud project as the site's OAuth client and enable it.
2. Open [API credentials](https://console.cloud.google.com/apis/credentials) and create a separate browser API key.
3. Restrict the key to **Websites / HTTP referrers**, adding `https://tssrkt.github.io/*` and `http://localhost:8000/*` for local test-branch validation.
4. Under API restrictions, restrict it to **Google Picker API**. Do not put an OAuth client secret in the frontend.
5. Add `http://localhost:8000` to the OAuth client's **Authorized JavaScript origins** so the branch can be tested locally without deploying it to the public site.
6. Put the public, restricted key in `GOOGLE_PICKER_API_KEY` in `js/config.js`.

The key is intentionally empty in source control. The app fails closed for Drive mutations until the key is configured.

## Migration behavior

- Existing OAuth sessions use the old session-storage key and are not silently reused after the scope change. The user must sign in again and grant the new scopes.
- A previously saved root folder is opened in Google Picker once to authorize that exact folder for `drive.file`.
- Existing shared catalog files can be read with `drive.readonly`; before updating or deleting one, the owner must authorize that exact file in Picker.
- A folder selected in Picker is not assumed to authorize every descendant. A nested folder is authorized separately before changing its inherited-permission setting.
- Newly created app catalog files and folders explicitly selected in Picker are marked as authorized for the current Google account in local storage as a UX optimization. Google Drive remains the authority and can still reject an operation.

## Test checklist

1. Sign in using a separate Google test account after configuring the API key.
2. Confirm OAuth uses `drive.readonly drive.appdata drive.file` and no `drive` scope.
3. Select the root folder and confirm it in Picker.
4. Publish a catalog, edit a book's metadata and publish again, then load the catalog from a friend account.
5. Revoke publication and confirm the catalog is removed.
6. Change a nested folder's sharing checkbox and confirm limited access still works.
7. Verify an unrelated, unselected file cannot be modified or deleted by the app.
8. Repeat after reload and after signing in with another account.

The final OAuth/Picker/API compatibility test requires the restricted API key and a real test account; unit tests cannot prove Google's server-side per-file authorization behavior.
