// Desktop installers live on the public nalamdesk-releases GitHub repo (the
// code repo is private). nalamdesk.com only redirects, so hosting can move
// without a new app release: the desktop app's default update feed is
// https://nalamdesk.com/updates/desktop (desktop/src/main/updates/updateFeed.ts).

export const RELEASES_REPO = 'https://github.com/sankara-sabapathy/nalamdesk-releases';
export const RELEASES_PAGE = `${RELEASES_REPO}/releases/latest`;

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Release tags are plain vX.Y.Z (build.yml bumps the patch version).
const FILE_VERSION = /\d+\.\d+\.\d+/;

export function isSafeFileName(name: string): boolean {
  return SAFE_FILE.test(name) && !name.includes('..');
}

/**
 * Where a feed file lives. Versioned packages and blockmaps resolve to their
 * own tagged release, so differential updates can still fetch an old
 * version's blockmap. Channel files (`latest*.yml`) follow the latest release.
 */
export function assetUrl(file: string): string {
  const version = /^latest(-[a-z]+)?\.yml$/.test(file) ? null : file.match(FILE_VERSION)?.[0];
  return version
    ? `${RELEASES_REPO}/releases/download/v${version}/${file}`
    : `${RELEASES_REPO}/releases/latest/download/${file}`;
}

/** Reads `version:` and `path:` from an electron-builder channel file. */
export function parseChannel(yml: string): { version?: string; path?: string } {
  const field = (key: string) => yml.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm'))?.[1];
  return { version: field('version'), path: field('path') };
}

export function redirect(location: string, cacheSeconds = 0): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}
