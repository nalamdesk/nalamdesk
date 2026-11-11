// www.nalamdesk.com -> nalamdesk.com, keeping path and query.
// 301 so browsers and search engines settle on the apex as canonical.
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = 'nalamdesk.com';
    url.port = '';
    return new Response(null, {
      status: 301,
      headers: { Location: url.toString(), 'Cache-Control': 'public, max-age=86400' },
    });
  },
};
