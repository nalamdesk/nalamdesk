import type { APIRoute } from 'astro';
import { isSafeFileName, notFound, proxyAsset } from '../../../lib/releases';

export const prerender = false;

// Generic electron-updater feed for the desktop app: every file streams from
// the GitHub release that holds it, served as nalamdesk.com.
export const GET: APIRoute = async ({ params, request }) => {
  // electron-builder publishes "NalamDesk Setup X.exe" as NalamDesk-Setup-X.exe;
  // map spaces the same way so an unsanitized latest.yml path still resolves.
  const file = (params.file ?? '').replaceAll(/\s+/g, '-');
  if (!isSafeFileName(file)) return notFound();
  try {
    return await proxyAsset(file, false, request.headers.get('Range'));
  } catch {
    return new Response('Update feed unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};
