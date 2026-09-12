// Web OAuth Client ID is public by design. Never add a client secret here.
export const GOOGLE_CLIENT_ID = '194069938786-5cbuhjli3skvq9ccbaee0nd1qjviqi9a.apps.googleusercontent.com';
export const ROOT_FOLDER_ID = '1Zx4Og7OR0_ERmYFzrWVDlyWBQ2cscN4f';
export const ROOT_FOLDER_RESOURCE_KEY = '';

export const INDEX_FILE_NAME = 'secret-library-index.json';
export const BUILDING_INDEX_FILE_NAME = 'secret-library-index-building.json';
export const INDEX_VERSION = 4;
export const METADATA_VERSION = 2;
export const COVER_CACHE_PREFIX = 'secret-library-cover-';
export const COVER_MAX_WIDTH = 240;
export const COVER_MAX_HEIGHT = 320;
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
export const ZIP_MAX_FB2_ENTRY_SIZE = 32 * 1024 * 1024;
