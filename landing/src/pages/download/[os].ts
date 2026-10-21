import type { APIRoute } from 'astro';
import { RELEASES_PAGE, assetUrl, parseChannel, redirect } from '../../lib/releases';

export const prerender = false;

// Stable download links for the website buttons. The installer name carries
// the version, so read the latest channel file and redirect to its package.
const CHANNELS: Record<string, { channel: string; pick: (c: { version?: string; path?: string }) => string | undefined }> = {
  windows: { channel: 'latest.yml', pick: (c) => c.path },
  // latest-linux.yml names the AppImage (the updater's package); clinics install the .deb.
  linux: { channel: 'latest-linux.yml', pick: (c) => (c.version ? `nalamdesk-desktop_${c.version}_amd64.deb` : undefined) },
};

export const GET: APIRoute = async ({ params }) => {
  const os = CHANNELS[params.os ?? ''];
  if (!os) return new Response('Not found', { status: 404 });
  try {
    const res = await fetch(assetUrl(os.channel), { redirect: 'follow', cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
    if (!res.ok) return redirect(RELEASES_PAGE);
    const file = os.pick(parseChannel(await res.text()));
    return redirect(file ? assetUrl(file) : RELEASES_PAGE, 300);
  } catch {
    return redirect(RELEASES_PAGE);
  }
};
