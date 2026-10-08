// Paragem proxy: a Cloudflare Worker (free tier) that forwards a few read-only
// STCP API paths and adds CORS headers. Nothing else is forwarded.
//
// Optional environment variable:
//   ALLOWED_ORIGIN  comma-separated origins allowed to call this proxy,
//                   e.g. "https://you.github.io". Default "*" (any origin).

const UPSTREAM = 'https://stcp.pt';

// Only these shapes are forwarded:
//   /api/stops/{id}/realtime   /api/stops/{id}/routes   /api/stops/{id}
//   /api/route/{id}/stops/direction?direction_id=0|1   /api/route/{id}/services
const ALLOWED = /^\/api\/(stops\/[A-Za-z0-9._-]{1,16}(\/(realtime|routes))?|route\/[A-Za-z0-9_-]{1,16}\/(stops\/direction|services))$/;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowList = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
    const anyOrigin = allowList.includes('*');
    const cors = {
      'Access-Control-Allow-Origin': anyOrigin ? '*' : (allowList.includes(origin) ? origin : allowList[0]),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Only GET', { status: 405, headers: cors });
    if (!anyOrigin && origin && !allowList.includes(origin)) return new Response('Origin not allowed', { status: 403, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED.test(url.pathname)) return new Response('Not found', { status: 404, headers: cors });

    const upstream = new URL(UPSTREAM + url.pathname);
    const dir = url.searchParams.get('direction_id');
    if (dir !== null) {
      if (!/^[01]$/.test(dir)) return new Response('Bad direction_id', { status: 400, headers: cors });
      upstream.searchParams.set('direction_id', dir);
    }

    const realtime = url.pathname.endsWith('/realtime');
    let res;
    try {
      res = await fetch(upstream, {
        headers: { Accept: 'application/json', 'User-Agent': 'Paragem personal proxy' },
        // Shared edge cache: realtime for 20 s, static stop lists for an hour.
        cf: { cacheTtl: realtime ? 20 : 3600, cacheEverything: true },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const headers = new Headers(cors);
    headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', realtime ? 'no-store' : 'public, max-age=3600');
    return new Response(res.body, { status: res.status, headers });
  },
};
