// End-to-end scenario driver for the local EdgeWorker simulator
// (test/local-simulator.mjs must be running, with the repo dev server up).
//   node test/run-scenarios.mjs
// Exercises the full lifecycle against the REAL Engage flow and REAL origin:
// bucketing, per-bucket cache isolation, hits vs misses, cookies, pv override,
// prefetch, spoofed headers, fail-open. Prints PASS/FAIL per check.
import { createHash } from 'node:crypto';

const SIM = process.env.EW_SIM || 'http://localhost:3100';
const PAGE = '/home/demo';
let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function sim(pathname) {
  return (await fetch(`${SIM}${pathname}`)).json();
}

async function request(path, { headers = {} } = {}) {
  const res = await fetch(`${SIM}${path}`, {
    headers: { 'x-ew-pz-debug': '1', ...headers },
    redirect: 'manual',
  });
  const body = Buffer.from(await res.arrayBuffer());
  const cookies = res.headers.getSetCookie?.() ?? [];
  const gtmRaw = cookies.find((c) => c.startsWith('sc_personalize_gtm='));
  return {
    status: res.status,
    bucketHeader: res.headers.get('x-ew-pz-bucket'),
    reason: res.headers.get('x-ew-pz-reason'),
    cookies,
    bid: cookies.find((c) => c.startsWith('bid_')),
    gtm: gtmRaw
      ? JSON.parse(decodeURIComponent(gtmRaw.slice('sc_personalize_gtm='.length, gtmRaw.indexOf(';'))))
      : null,
    hash: createHash('sha1').update(body).digest('hex').slice(0, 12),
    size: body.length,
    last: await sim('/__sim/last'),
  };
}

console.log(`Driving simulator at ${SIM}\n`);
await sim('/__sim/reset');
await sim('/__sim/timeouts?ms=0');

console.log('1. Anonymous first visit');
const anon1 = await request(PAGE);
check('status 200', anon1.status === 200);
check('cache MISS', anon1.last.disp === 'MISS');
check('bucket = default', anon1.last.bucket === 'default');
check('flow executed (browser/create + callFlows)', anon1.last.engage.some((u) => u.includes('browser/create')) && anon1.last.engage.some((u) => u.includes('callFlows')));
check('bid cookie set for new visitor', Boolean(anon1.bid) && anon1.bid.includes('SameSite=None'));
check('no gtm cookie on default bucket', anon1.gtm === null);
check('no forward rewrite', anon1.last.forward === null);
check('debug reason = flow-unassigned', anon1.reason === 'flow-unassigned', String(anon1.reason));

console.log('2. Anonymous repeat (shared cache, fresh decision)');
const anon2 = await request(PAGE);
check('cache HIT — origin not called', anon2.last.disp === 'HIT');
check('decision still ran on the hit', anon2.last.engage.some((u) => u.includes('callFlows')));
check('bid cookie still set on a hit', Boolean(anon2.bid));
check('same cached body as first visit', anon2.hash === anon1.hash, `${anon2.hash} vs ${anon1.hash}`);

console.log('3. Logged-in visitor (cclUser) first visit');
const auth1 = await request(PAGE, { headers: { Cookie: 'cclUser=1' } });
check('status 200', auth1.status === 200);
check('cache MISS (new bucket)', auth1.last.disp === 'MISS');
check('bucket = logged-in-non-booked', auth1.last.bucket === 'logged-in-non-booked');
check('forward path = variant route', auth1.last.forward === '/home/demo/Page%20Variants/Logged-In-Non-Booked', String(auth1.last.forward));
check('gtm cookie carries the page experience', auth1.gtm?.experiences?.[0]?.variantId === 'Logged-In-Non-Booked' && auth1.gtm?.experiences?.[0]?.type === 'page');
check('variant HTML differs from default', auth1.hash !== anon1.hash);
check('debug reason = flow', auth1.reason === 'flow', String(auth1.reason));

console.log('4. Logged-in repeat');
const auth2 = await request(PAGE, { headers: { Cookie: 'cclUser=1' } });
check('cache HIT', auth2.last.disp === 'HIT');
check('gtm cookie still set on the hit', auth2.gtm?.experiences?.[0]?.variantId === 'Logged-In-Non-Booked');
check('same cached variant body', auth2.hash === auth1.hash);

console.log('5. Anonymous after logged-in (bucket isolation)');
const anon3 = await request(PAGE);
check('cache HIT on default bucket', anon3.last.disp === 'HIT' && anon3.last.bucket === 'default');
check('default body, not the variant', anon3.hash === anon1.hash, `${anon3.hash} vs ${anon1.hash}`);

console.log('6. ?pv= test override (valid variant)');
const pv = await request(`${PAGE}?pv=Logged-In-Booked`);
check('bucket = logged-in-booked', pv.last.bucket === 'logged-in-booked');
check('no Engage sub-requests in pv mode', pv.last.engage.length === 0);
check('forward path = forced variant', pv.last.forward === '/home/demo/Page%20Variants/Logged-In-Booked');
check('forced variant body differs from default', pv.hash !== anon1.hash);

console.log('6b. Every allowed variant URL resolves on the origin');
for (const variant of ['Logged-In-Booked', 'Logged-In-Courtesy-Hold', 'Logged-In-Non-Booked', 'Logged-In-Recently-Searched']) {
  const v = await request(`${PAGE}?pv=${variant}`);
  check(
    `${variant}: 200, bucketed, variant body`,
    v.status === 200 &&
      v.last.bucket === variant.toLowerCase() &&
      v.last.forward === `/home/demo/Page%20Variants/${variant.replace(/ /g, '%20')}` &&
      v.hash !== anon1.hash,
    `status ${v.status} bucket ${v.last.bucket}`
  );
}

console.log('7. ?pv= with unknown variant');
const pvBad = await request(`${PAGE}?pv=Not-A-Variant`);
check('falls back to default bucket', pvBad.last.bucket === 'default');
check('no rewrite', pvBad.last.forward === null);

console.log('8. Spoofed inbound state headers');
const spoof = await request(PAGE, {
  headers: { 'x-ew-pz-gtm': encodeURIComponent('{"evil":true}'), 'x-ew-pz-bid': 'evil-bid' },
});
check('spoofed gtm not reflected as a cookie', spoof.gtm === null || spoof.gtm.evil === undefined);
check('spoofed bid not reflected', !spoof.bid || !spoof.bid.includes('evil-bid'));
check('served default bucket normally', spoof.last.bucket === 'default');

console.log('9. Prefetch request');
const pref = await request(PAGE, { headers: { purpose: 'prefetch' } });
check('default bucket, no flow call', pref.last.bucket === 'default' && pref.last.engage.length === 0);

console.log('10. Non-personalized path passes through');
const passThru = await request('/home/definitely-not-a-route');
check('disposition PASS (no bucketing)', passThru.last.disp === 'PASS' && passThru.last.bucket === null);
check('no EW cookies on pass-through', !passThru.bid && passThru.gtm === null);

console.log('11. Fail-open on sub-request timeout (1ms)');
await sim('/__sim/reset');
await sim('/__sim/timeouts?ms=1');
const timeout = await request(PAGE, { headers: { Cookie: 'cclUser=1' } });
check('serves default bucket', timeout.last.bucket === 'default');
check('still 200 to the visitor', timeout.status === 200);
check('error was logged, not thrown', timeout.last.errors.length > 0);
check('debug reason = no-browser-id (create timed out)', timeout.reason === 'no-browser-id', String(timeout.reason));
await sim('/__sim/timeouts?ms=0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
