import type { APIRoute } from 'astro';
import { isSafeFileName, notFound, parseChannel, proxyAsset } from '../../lib/releases';

export const prerender = false;

// Stable download links for the website buttons. The installer name carries
// the version, so read the latest channel file and stream its package.
const CHANNELS: Record<string, { channel: string; pick: (c: { version?: string; path?: string }) => string | undefined }> = {
  windows: { channel: 'latest.yml', pick: (c) => c.path },
  // latest-linux.yml names the AppImage (the updater's package); clinics install the .deb.
  linux: { channel: 'latest-linux.yml', pick: (c) => (c.version ? `nalamdesk-desktop_${c.version}_amd64.deb` : undefined) },
};

const UNAVAILABLE = 'This download is not available yet. Please try again later.';

export const GET: APIRoute = async ({ params }) => {
  const os = CHANNELS[params.os ?? ''];
  if (!os) return notFound();
  try {
    const channel = await proxyAsset(os.channel);
    if (!channel.ok) return notFound(UNAVAILABLE);
    const file = os.pick(parseChannel(await channel.text()))?.replaceAll(/\s+/g, '-');
    if (!file || !isSafeFileName(file)) return notFound(UNAVAILABLE);
    return await proxyAsset(file, true);
  } catch {
    return new Response(UNAVAILABLE, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};
