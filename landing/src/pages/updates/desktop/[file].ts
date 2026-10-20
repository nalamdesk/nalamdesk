import type { APIRoute } from 'astro';
import { assetUrl, isSafeFileName, redirect } from '../../../lib/releases';

export const prerender = false;

// Generic electron-updater feed for the desktop app: every file redirects to
// the GitHub release that holds it. Never cached, so a new release shows up
// on the next check.
export const GET: APIRoute = ({ params }) => {
  const file = params.file ?? '';
  if (!isSafeFileName(file)) return new Response('Not found', { status: 404 });
  return redirect(assetUrl(file));
};
