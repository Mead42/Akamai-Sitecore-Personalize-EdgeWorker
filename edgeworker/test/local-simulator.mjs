// Local Akamai EdgeWorker simulator.
//
// Runs the REAL main.js handlers around an in-memory per-bucket cache in front
// of the local dev origin, with LIVE Engage sub-requests — the same request
// lifecycle Akamai implements: onClientRequest before cache lookup, cache key
// = URL + bucket variable (route() changes excluded, like Akamai), forward on
// miss with the worker's mutated headers, Set-Cookie stripped from cached
// responses, onClientResponse on hits and misses.
//
// Start (from akamai/edgeworker, with the repo dev server running):
//   EW_HTTP=live node --import ./test/register.mjs test/local-simulator.mjs
// Then run the scenario driver:
//   node test/run-scenarios.mjs
//
// Control endpoints: GET /__sim/last (last request's disposition, for the
// driver), GET /__sim/reset (clear cache), GET /__sim/timeouts?ms=N (override
// sub-request timeouts to force fail-open; ms=0 restores).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CONFIG from '../config.js';
import { onClientRequest, onClientResponse } from '../main.js';
import { makeRequest, makeResponse } from './harness.js';
import { __getHttpCalls, __resetHttp } from 'http-request';
import { __getLogs, __clearLogs } from 'log';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local nginx self-signed cert

const here = path.dirname(fileURLToPath(import.meta.url));
// Nonprod Engage values come from the repo .env so no keys live in this file.
const envText = fs.readFileSync(path.join(here, '..', '..', '..', '.env'), 'utf8');
const envVal = (key) => envText.match(new RegExp('^' + key + '=(.*)$', 'm'))?.[1]?.trim();

const ORIGIN = process.env.EW_ORIGIN || 'https://dev.carnival.com';
const PORT = Number(process.env.EW_PORT || 3100);
const DEFAULT_TIMEOUTS = [CONFIG.BROWSER_CREATE_TIMEOUT_MS, CONFIG.CALLFLOWS_TIMEOUT_MS];

// Test-route config: the TST demo page, whose flow and variants are live.
CONFIG.ENABLED = true;
CONFIG.DEBUG = true;
CONFIG.CLIENT_KEY = envVal('NEXT_PUBLIC_ENGAGE_CLIENT_KEY');
CONFIG.COOKIE_DOMAIN = '';
CONFIG.ROUTES = [
  {
    hosts: [],
    paths: ['/home/demo'],
    friendlyId: 'cc_page_1cba295a68704d98b706739624749bb7',
    allowedVariants: [
      'Logged-In-Booked',
      'Logged-In-Courtesy-Hold',
      'Logged-In-Non-Booked',
      'Logged-In-Recently-Searched',
    ],
    market: { pointOfSale: 'carnivalUS', currency: 'USD', language: 'en' },
  },
];

const cache = new Map();
let seq = 0;
let last = null;

const server = http.createServer(async (req, res) => {
  const [pathname, query = ''] = req.url.split('?');

  if (pathname.startsWith('/__sim/')) {
    if (pathname === '/__sim/reset') cache.clear();
    if (pathname === '/__sim/timeouts') {
      const ms = Number(new URLSearchParams(query).get('ms')) || 0;
      [CONFIG.BROWSER_CREATE_TIMEOUT_MS, CONFIG.CALLFLOWS_TIMEOUT_MS] = ms
        ? [ms, ms]
        : DEFAULT_TIMEOUTS;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pathname === '/__sim/last' ? last : { ok: true, cacheSize: cache.size }));
    return;
  }

  const n = ++seq;
  try {
    const ewReq = makeRequest({
      method: req.method,
      host: 'dev.carnival.com',
      path: pathname,
      query,
      headers: req.headers,
    });
    __resetHttp();
    __clearLogs();
    await onClientRequest(ewReq);

    const engage = __getHttpCalls().map((c) => new URL(c.url).pathname);
    const bucket = ewReq.__variables[CONFIG.CACHE_KEY_VARIABLE];
    const forward = ewReq.__routed[0]?.path;
    const isRoute = ewReq.__includedVariables.includes(CONFIG.CACHE_KEY_VARIABLE);
    // Akamai cache key: client URL + the PMUSER bucket variable. The route()
    // forward path is deliberately NOT part of the key.
    const key = `${pathname}?${query}|${bucket}`;

    let disp;
    let entry;
    if (isRoute && req.method === 'GET' && cache.has(key)) {
      entry = cache.get(key);
      disp = 'HIT';
    } else {
      const fwdHeaders = {};
      for (const [name, vals] of ewReq.__headers) fwdHeaders[name] = vals.join(', ');
      delete fwdHeaders.host;
      delete fwdHeaders.connection;
      delete fwdHeaders['content-length'];
      const originRes = await fetch(ORIGIN + (forward || pathname) + (query ? '?' + query : ''), {
        method: req.method,
        headers: fwdHeaders,
        redirect: 'manual',
      });
      const originCookies = originRes.headers.getSetCookie?.() ?? [];
      const headers = {};
      for (const [hn, hv] of originRes.headers) {
        if (!['set-cookie', 'transfer-encoding', 'content-encoding', 'content-length', 'connection'].includes(hn)) {
          headers[hn] = hv;
        }
      }
      entry = { status: originRes.status, headers, body: Buffer.from(await originRes.arrayBuffer()) };
      if (originCookies.length && isRoute) {
        // Mirrors the property rule "remove Set-Cookie from cached responses";
        // anything showing up here is a finding for the Akamai config.
        console.log(`  [${n}] WARN origin Set-Cookie stripped: ${originCookies.map((c) => c.split('=')[0]).join(', ')}`);
      }
      disp = isRoute ? 'MISS' : 'PASS';
      if (isRoute && req.method === 'GET' && entry.status === 200) cache.set(key, entry);
    }

    const ewRes = makeResponse({ status: entry.status });
    for (const [hn, hv] of Object.entries(entry.headers)) ewRes.setHeader(hn, hv);
    onClientResponse(ewReq, ewRes);

    const errors = __getLogs().filter((l) => l.level === 'error').map((l) => l.message);
    last = { n, method: req.method, url: req.url, disp, bucket: bucket ?? null, forward: forward ?? null, engage, errors };
    console.log(
      `[${n}] ${req.method} ${req.url} -> ${disp} bucket=${bucket ?? '-'} fwd=${forward ?? '-'} engage=[${engage.join(' ')}]` +
        (errors.length ? ` ERR: ${errors.join(' | ')}` : '')
    );

    const out = {};
    for (const [hn, vals] of ewRes.__headers) out[hn] = vals.length === 1 ? vals[0] : vals;
    res.writeHead(ewRes.status, out);
    res.end(entry.body);
  } catch (err) {
    console.error(`[${n}] simulator error:`, err);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('simulator error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`EdgeWorker simulator on http://localhost:${PORT} -> origin ${ORIGIN}`);
  console.log(`Personalized route: /home/demo (friendlyId ${CONFIG.ROUTES[0].friendlyId})`);
});
