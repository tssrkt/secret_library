// Web OAuth Client ID is public by design. Never add a client secret here.
export const GOOGLE_CLIENT_ID = '194069938786-5cbuhjli3skvq9ccbaee0nd1qjviqi9a.apps.googleusercontent.com';
export const ROOT_FOLDER_ID = '1Zx4Og7OR0_ERmYFzrWVDlyWBQ2cscN4f';
export const ROOT_FOLDER_RESOURCE_KEY = '';

export const INDEX_FILE_NAME = 'secret-library-index.json';
export const INDEX_VERSION = 3;
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SCAN_CONCURRENCY = 4;
export const METADATA_CONCURRENCY = 3;
export const METADATA_CHECKPOINT_SIZE = 50;
export const ZIP_TAIL_SIZE = 65_557;
export const ZIP_MAX_CENTRAL_DIRECTORY_SIZE = 4 * 1024 * 1024;
export const ZIP_MAX_COMPRESSED_ENTRY_SIZE = 16 * 1024 * 1024;
export const ZIP_MAX_DESCRIPTION_SIZE = 1024 * 1024;
