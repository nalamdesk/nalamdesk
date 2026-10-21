// Desktop installers live on the public nalamdesk/releases GitHub repo (the
// code repo is private). nalamdesk.com streams them through this worker, so
// visitors and the desktop app never leave nalamdesk.com and hosting can move
// without a new app release: the app's default update feed is
// https://nalamdesk.com/updates/desktop (desktop/src/main/updates/updateFeed.ts).

const RELEASES_REPO = 'https://github.com/nalamdesk/releases';

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Release tags are plain vX.Y.Z (build.yml bumps the patch version).
const FILE_VERSION = /\d+\.\d+\.\d+/;
const CHANNEL_FILE = /^latest(-[a-z]+)?\.yml$/;

export function isSafeFileName(name: string): boolean {
  return SAFE_FILE.test(name) && !name.includes('..');
}

/**
 * Where a feed file lives. Versioned packages and blockmaps resolve to their
 * own tagged release, so differential updates can still fetch an old
 * version's blockmap. Channel files (`latest*.yml`) follow the latest release.
 */
export function assetUrl(file: string): string {
  const version = CHANNEL_FILE.test(file) ? null : FILE_VERSION.exec(file)?.[0];
  return version
    ? `${RELEASES_REPO}/releases/download/v${version}/${file}`
    : `${RELEASES_REPO}/releases/latest/download/${file}`;
}

/** Reads `version:` and `path:` from an electron-builder channel file. */
export function parseChannel(yml: string): { version?: string; path?: string } {
  const field = (key: string) => yml.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm'))?.[1];
  return { version: field('version'), path: field('path') };
}

/**
 * Streams a release asset from GitHub as a nalamdesk.com response. Versioned
 * files never change, so Cloudflare caches them; channel files are never
 * cached, so a new release shows up on the next update check.
 */
export async function proxyAsset(file: string, download = false, range?: string | null): Promise<Response> {
  const channel = CHANNEL_FILE.test(file);
  const upstream = await fetch(assetUrl(file), {
    redirect: 'follow',
    // electron-updater's differential download asks for byte ranges of the package.
    headers: range && !channel ? { Range: range } : undefined,
    cf: channel ? { cacheTtl: 0 } : { cacheTtl: 31536000, cacheEverything: true },
  } as RequestInit);
  if (!upstream.ok) return notFound();
  const partial = upstream.status === 206;
  const headers = new Headers({
    'Content-Type': channel
      ? 'text/yaml; charset=utf-8'
      : (partial && upstream.headers.get('Content-Type')) || 'application/octet-stream',
    'Cache-Control': channel ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  const length = upstream.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);
  const contentRange = upstream.headers.get('Content-Range');
  if (contentRange) headers.set('Content-Range', contentRange);
  if (!channel) headers.set('Accept-Ranges', 'bytes');
  if (download) headers.set('Content-Disposition', `attachment; filename="${file}"`);
  return new Response(upstream.body, { status: partial ? 206 : 200, headers });
}

export function notFound(message = 'Not found'): Response {
  return new Response(message, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
