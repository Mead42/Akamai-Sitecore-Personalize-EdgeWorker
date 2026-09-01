// Scenario tests for the Sitecore Personalize EdgeWorker, run entirely locally
// against mocked Akamai built-ins and a mocked Engage API:
//   node --import ./test/register.mjs --test ./test/
//
// CONFIG is overwritten with deterministic test values below, so these tests
// pass regardless of the TODO placeholders in config.js. config.test.js
// (separate process) validates the shipped config's structure.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import CONFIG from '../config.js';
import { onClientRequest, onClientResponse } from '../main.js';
import { makeRequest, makeResponse } from './harness.js';
import { __setHttpHandler, __getHttpCalls, __resetHttp } from 'http-request';
import { __getLogs, __clearLogs } from 'log';

const US_HOST = 'www.carnival.com';
const AU_HOST = 'www.carnival.com.au';
const CLIENT_KEY = 'ck_test';
const BID_COOKIE = `bid_${CLIENT_KEY}`;

function applyTestConfig() {
  CONFIG.ENABLED = true;
  CONFIG.CLIENT_KEY = CLIENT_KEY;
  CONFIG.ENGAGE_API_BASE = '/__engage';
  CONFIG.COOKIE_DOMAIN = '';
  CONFIG.DEBUG = true;
  CONFIG.MAX_COOKIE_PARAM_VALUE_BYTES = 1024;
  CONFIG.MAX_COOKIE_PARAMS_TOTAL_BYTES = 8192;
  CONFIG.ROUTES = [
    // Mirrors the real config: language/market comes from the host, both
    // homepages are client path '/', and the forward path is originPath.
    {
      hosts: [AU_HOST],
      paths: ['/'],
      originPath: '/home',
      friendlyId: 'au_home',
      allowedVariants: ['AU-Var-One'],
      market: { pointOfSale: 'carnivalAU', currency: 'AUD', language: 'en' },
      selectedCurrencyMarkets: {
        AUD: { pointOfSale: 'carnivalAU', currency: 'AUD' },
        NZD: { pointOfSale: 'carnivalNZ', currency: 'NZD' },
      },
    },
    {
      hosts: [],
      paths: ['/'],
      friendlyId: 'us_home',
      allowedVariants: [
        'Logged-In-Booked',
        'Logged-In-Courtesy-Hold',
        'Logged-In-Non-Booked',
        'Logged-In-Recently-Searched',
      ],
      market: { pointOfSale: 'carnivalUS', currency: 'USD', language: 'en' },
    },
    // Mechanism-coverage route: path normalization + empty allowedVariants
    // (trust whatever the flow returns).
    {
      hosts: [],
      paths: ['/mech-page'],
      friendlyId: 'mech_page',
      allowedVariants: [],
      market: { pointOfSale: 'carnivalUS', currency: 'USD', language: 'en' },
    },
  ];
}

/** Answers browser/create with { ref } and callFlows with flowResult.
 *  browser/create answers 201 like the real Engage API (verified live). */
function stubEngage({ ref = 'new-ref-1', flowResult = {} } = {}) {
  __setHttpHandler(async (url) => {
    if (url.includes('/v1.2/browser/create.json')) return { status: 201, json: { ref } };
    if (url.endsWith('/v2/callFlows')) return { status: 200, json: flowResult };
    throw new Error(`unexpected sub-request url: ${url}`);
  });
}

function header(req, name) {
  const values = req.getHeader(name);
  return values ? values[0] : undefined;
}

function callFlowsBody() {
  const call = __getHttpCalls().find((c) => c.url.endsWith('/v2/callFlows'));
  return call ? JSON.parse(call.options.body) : undefined;
}

function gtmPayload(req) {
  const raw = header(req, 'x-ew-pz-gtm');
  return raw === undefined ? undefined : JSON.parse(decodeURIComponent(raw));
}

beforeEach(() => {
  applyTestConfig();
  __resetHttp();
  __clearLogs();
});

describe('routing and pass-through', () => {
  it('leaves non-configured paths untouched (no cache-key variable, no origin header)', async () => {
    const req = makeRequest({ path: '/cruise-deals' });
    await onClientRequest(req);

    assert.equal(Object.keys(req.__variables).length, 0);
    assert.equal(req.__includedVariables.length, 0);
    assert.equal(req.__routed.length, 0);
    assert.equal(header(req, 'x-edge-personalize'), undefined);
    assert.equal(__getHttpCalls().length, 0);
  });

  it('ignores non-GET/HEAD methods', async () => {
    const req = makeRequest({ method: 'POST', path: '/' });
    await onClientRequest(req);
    assert.equal(Object.keys(req.__variables).length, 0);
    assert.equal(__getHttpCalls().length, 0);
  });

  it('does nothing when ENABLED is false', async () => {
    CONFIG.ENABLED = false;
    const req = makeRequest({ path: '/' });
    await onClientRequest(req);
    assert.equal(Object.keys(req.__variables).length, 0);
    assert.equal(__getHttpCalls().length, 0);
  });

  it('always strips spoofed inbound state headers, even on pass-through requests', async () => {
    const req = makeRequest({
      method: 'POST',
      path: '/not-personalized',
      headers: {
        'x-ew-pz-bid': 'evil-bid',
        'x-ew-pz-gtm': encodeURIComponent('{"evil":true}'),
        'x-ew-pz-bucket': 'evil-bucket',
      },
    });
    await onClientRequest(req);

    assert.equal(header(req, 'x-ew-pz-bid'), undefined);
    assert.equal(header(req, 'x-ew-pz-gtm'), undefined);
    assert.equal(header(req, 'x-ew-pz-bucket'), undefined);

    // And therefore onClientResponse sets no cookies from spoofed values.
    const res = makeResponse();
    onClientResponse(req, res);
    assert.equal(res.getHeader('Set-Cookie'), undefined);
  });

  it('matches paths case-insensitively and ignores trailing slashes', async () => {
    stubEngage({ flowResult: { pageVariantId: 'Any-Variant' } });
    const req = makeRequest({ path: '/Mech-Page/', headers: { Cookie: `${BID_COOKIE}=b1` } });
    await onClientRequest(req);
    assert.equal(callFlowsBody().friendlyId, 'mech_page');
    // Empty allowedVariants = trust the flow's answer.
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'any-variant');
    assert.equal(req.__routed[0].path, '/Mech-Page/Page%20Variants/Any-Variant');
  });

  it('picks the route by host filter, first match wins', async () => {
    stubEngage({ flowResult: {} });
    const us = makeRequest({ host: US_HOST, path: '/', headers: { Cookie: `${BID_COOKIE}=b1` } });
    await onClientRequest(us);
    assert.equal(callFlowsBody().friendlyId, 'us_home');

    __resetHttp();
    stubEngage({ flowResult: {} });
    const au = makeRequest({ host: AU_HOST, path: '/', headers: { Cookie: `${BID_COOKIE}=b1` } });
    await onClientRequest(au);
    assert.equal(callFlowsBody().friendlyId, 'au_home');
  });
});

describe('returning visitor happy path (US)', () => {
  it('calls only callFlows, rewrites to the variant path, and sets bucket + gtm state', async () => {
    stubEngage({ flowResult: { pageVariantId: 'Logged-In-Booked' } });
    const req = makeRequest({
      host: US_HOST,
      path: '/',
      query: 'utm_source=email&foo=bar',
      headers: {
        Cookie: `${BID_COOKIE}=abc123; cclUser=1`,
        referer: 'https://www.google.com/',
      },
    });
    await onClientRequest(req);

    // Exactly one sub-request: no browser/create for a visitor with a bid cookie.
    const calls = __getHttpCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/__engage/v2/callFlows');
    assert.equal(calls[0].options.headers['X-Library-Version'], CONFIG.LIBRARY_VERSION);

    // callFlows body mirrors the middleware byte-for-byte.
    const body = callFlowsBody();
    assert.equal(body.channel, 'WEB');
    assert.equal(body.clientKey, CLIENT_KEY);
    assert.equal(body.currencyCode, 'USD');
    assert.equal(body.pointOfSale, 'carnivalUS');
    assert.equal(body.language, 'en');
    assert.equal(body.friendlyId, 'us_home');
    assert.equal(body.browserId, 'abc123');
    assert.equal(body.params.referrer, 'https://www.google.com/');
    assert.equal(body.params.utm_source, 'email');
    assert.equal(body.params.qs_utm_source, 'email');
    assert.equal(body.params.qs_foo, 'bar');
    assert.equal(body.params[`cookies_${BID_COOKIE}`], 'abc123');
    assert.equal(body.params.cookies_cclUser, '1');

    // Forward request rewritten; client URL untouched (route() only).
    assert.equal(req.__routed.length, 1);
    assert.equal(req.__routed[0].path, '/Page%20Variants/Logged-In-Booked');

    // Bucket in the cache key.
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'logged-in-booked');
    assert.ok(req.__includedVariables.includes('PMUSER_EW_BUCKET'));

    // State headers for origin + onClientResponse.
    assert.equal(header(req, 'x-edge-personalize'), '1');
    assert.equal(header(req, 'x-ew-pz-bucket'), 'logged-in-booked');
    assert.equal(header(req, 'x-ew-pz-reason'), 'flow');
    assert.equal(header(req, 'x-ew-pz-bid'), undefined); // not a new visitor
    assert.deepEqual(gtmPayload(req), {
      browserId: 'abc123',
      experiences: [{ friendlyId: 'us_home', variantId: 'Logged-In-Booked', type: 'page' }],
    });
  });

  it('accepts a flow variant in any spacing/case but rewrites with the raw value', async () => {
    stubEngage({ flowResult: { pageVariantId: 'logged in booked' } });
    const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
    await onClientRequest(req);

    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'logged-in-booked');
    assert.equal(req.__routed[0].path, '/Page%20Variants/logged%20in%20booked');
  });
});

describe('new visitor', () => {
  it('creates a browser id first, then calls the flow with it and flags the bid for onClientResponse', async () => {
    stubEngage({ ref: 'fresh-ref', flowResult: { variantId: 'Logged-In-Non-Booked' } });
    const req = makeRequest({ path: '/' });
    await onClientRequest(req);

    const calls = __getHttpCalls();
    assert.equal(calls.length, 2);
    assert.ok(
      calls[0].url.startsWith(
        `/__engage/v1.2/browser/create.json?client_key=${CLIENT_KEY}&message=%7B%7D`
      )
    );
    assert.equal(calls[1].url, '/__engage/v2/callFlows');
    assert.equal(callFlowsBody().browserId, 'fresh-ref');
    assert.equal(header(req, 'x-ew-pz-bid'), 'fresh-ref');
    assert.equal(gtmPayload(req).browserId, 'fresh-ref');
  });

  it('serves the default bucket when browser/create fails, without calling the flow', async () => {
    __setHttpHandler(async () => ({ status: 500 }));
    const req = makeRequest({ path: '/' });
    await onClientRequest(req);

    assert.equal(__getHttpCalls().length, 1);
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'default');
    assert.equal(req.__routed.length, 0);
    assert.equal(header(req, 'x-ew-pz-bucket'), 'default');
    assert.equal(header(req, 'x-ew-pz-bid'), undefined);
  });
});

describe('fail open', () => {
  const failureModes = [
    ['callFlows returns non-200', 'flow-error', async (url) =>
      url.includes('browser/create') ? { status: 201, json: { ref: 'r1' } } : { status: 503 }],
    ['callFlows throws (timeout)', 'flow-error', async (url) => {
      if (url.includes('browser/create')) return { status: 201, json: { ref: 'r1' } };
      throw new Error('subrequest timed out');
    }],
    ['flow returns no variant', 'flow-unassigned', async () => ({ status: 200, json: {} })],
    ['flow returns an unknown variant', 'flow-unknown-variant', async () => ({ status: 200, json: { pageVariantId: 'Rogue-Variant' } })],
    ['flow returns garbage', 'flow-unassigned', async () => ({ status: 200, json: 'not-an-object' })],
  ];

  for (const [name, reason, handler] of failureModes) {
    it(`${name} -> default bucket, no rewrite, reason ${reason}`, async () => {
      __setHttpHandler(handler);
      const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
      await onClientRequest(req);

      assert.equal(req.__variables.PMUSER_EW_BUCKET, 'default');
      assert.ok(req.__includedVariables.includes('PMUSER_EW_BUCKET'));
      assert.equal(req.__routed.length, 0);
      assert.equal(header(req, 'x-ew-pz-bucket'), 'default');
      assert.equal(header(req, 'x-ew-pz-reason'), reason);
      assert.equal(header(req, 'x-ew-pz-gtm'), undefined);
      assert.equal(header(req, 'x-edge-personalize'), '1');
    });
  }

  it('never throws out of onClientRequest even when the request object misbehaves', async () => {
    const req = makeRequest({ path: '/' });
    req.getHeader = () => {
      throw new Error('boom');
    };
    await onClientRequest(req); // must resolve, not reject
    assert.ok(__getLogs().some((l) => l.message.includes('onClientRequest failed')));
  });

  it('never throws out of onClientResponse even when the request object misbehaves', () => {
    const req = makeRequest({});
    req.getHeader = () => {
      throw new Error('boom');
    };
    onClientResponse(req, makeResponse());
    assert.ok(__getLogs().some((l) => l.message.includes('onClientResponse failed')));
  });
});

describe('?pv= test override', () => {
  it('uses the forced variant with no sub-requests at all', async () => {
    const req = makeRequest({ path: '/', query: 'pv=Logged-In-Booked' });
    await onClientRequest(req);

    assert.equal(__getHttpCalls().length, 0);
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'logged-in-booked');
    assert.equal(req.__routed[0].path, '/Page%20Variants/Logged-In-Booked');
    assert.equal(header(req, 'x-ew-pz-reason'), 'pv-override');
    const payload = gtmPayload(req);
    assert.equal('browserId' in payload, false); // no bid cookie, none created
  });

  it('rejects a forced variant that is not in allowedVariants', async () => {
    const req = makeRequest({ path: '/', query: 'pv=Not-A-Real-Variant' });
    await onClientRequest(req);

    assert.equal(__getHttpCalls().length, 0);
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'default');
    assert.equal(req.__routed.length, 0);
    assert.equal(header(req, 'x-ew-pz-reason'), 'pv-invalid');
  });
});

describe('prefetch guard', () => {
  for (const headers of [
    { purpose: 'prefetch' },
    { 'sec-purpose': 'prefetch;prerender' },
    { 'next-router-prefetch': '1' },
    { 'x-moz': 'prefetch' },
  ]) {
    it(`serves default without a flow call for ${JSON.stringify(headers)}`, async () => {
      const req = makeRequest({ path: '/', headers });
      await onClientRequest(req);

      assert.equal(__getHttpCalls().length, 0);
      assert.equal(req.__variables.PMUSER_EW_BUCKET, 'default');
      assert.ok(req.__includedVariables.includes('PMUSER_EW_BUCKET'));
      assert.equal(header(req, 'x-edge-personalize'), '1');
      assert.equal(header(req, 'x-ew-pz-bucket'), 'default');
      assert.equal(req.__routed.length, 0);
    });
  }
});

describe('AU market resolution', () => {
  it('defaults to carnivalAU / AUD', async () => {
    stubEngage({ flowResult: {} });
    const req = makeRequest({ host: AU_HOST, path: '/', headers: { Cookie: `${BID_COOKIE}=b1` } });
    await onClientRequest(req);

    const body = callFlowsBody();
    assert.equal(body.pointOfSale, 'carnivalAU');
    assert.equal(body.currencyCode, 'AUD');
    assert.equal(body.language, 'en');
  });

  it('honours SelectedCurrency=NZD', async () => {
    stubEngage({ flowResult: {} });
    const req = makeRequest({
      host: AU_HOST,
      path: '/',
      headers: { Cookie: `${BID_COOKIE}=b1; SelectedCurrency=nzd` },
    });
    await onClientRequest(req);

    const body = callFlowsBody();
    assert.equal(body.pointOfSale, 'carnivalNZ');
    assert.equal(body.currencyCode, 'NZD');
  });

  it('ignores an unknown SelectedCurrency value', async () => {
    stubEngage({ flowResult: {} });
    const req = makeRequest({
      host: AU_HOST,
      path: '/',
      headers: { Cookie: `${BID_COOKIE}=b1; SelectedCurrency=USD` },
    });
    await onClientRequest(req);

    assert.equal(callFlowsBody().pointOfSale, 'carnivalAU');
    assert.equal(callFlowsBody().currencyCode, 'AUD');
  });

  it('builds the variant rewrite from originPath when the client path differs', async () => {
    stubEngage({ flowResult: { pageVariantId: 'AU-Var-One' } });
    const req = makeRequest({ host: AU_HOST, path: '/', headers: { Cookie: `${BID_COOKIE}=b1` } });
    await onClientRequest(req);

    assert.equal(req.__routed[0].path, '/home/Page%20Variants/AU-Var-One');
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'au-var-one');
  });
});

describe('experience params edge cases', () => {
  it('parses the query string like the middleware (last value wins, + as space, percent-decoding)', async () => {
    stubEngage({ flowResult: {} });
    const req = makeRequest({
      path: '/',
      query: 'a=1&a=2&sp=a+b&enc=%2Fx&flag',
      headers: { Cookie: `${BID_COOKIE}=b1` },
    });
    await onClientRequest(req);

    const params = callFlowsBody().params;
    assert.equal(params.qs_a, '2');
    assert.equal(params.qs_sp, 'a b');
    assert.equal(params.qs_enc, '/x');
    assert.equal(params.qs_flag, '');
    assert.equal(params.referrer, 'about:client');
  });

  it('skips oversized cookies and stops at the total budget', async () => {
    CONFIG.MAX_COOKIE_PARAM_VALUE_BYTES = 10;
    CONFIG.MAX_COOKIE_PARAMS_TOTAL_BYTES = 30;
    stubEngage({ flowResult: {} });
    const req = makeRequest({
      path: '/',
      headers: {
        Cookie: `${BID_COOKIE}=b1; huge=${'x'.repeat(50)}; small1=aa; small2=bb; small3=cc; small4=dd`,
      },
    });
    await onClientRequest(req);

    const params = callFlowsBody().params;
    assert.equal(params.cookies_huge, undefined); // over per-value cap
    assert.equal(params[`cookies_${BID_COOKIE}`], 'b1');
    assert.equal(params.cookies_small1, 'aa');
    // Budget (30 bytes) exhausted before the tail cookies.
    assert.equal(params.cookies_small3, undefined);
    assert.equal(params.cookies_small4, undefined);
  });
});

describe('onClientResponse cookies', () => {
  it('sets the bid cookie for new visitors (365d, SameSite=None, Secure)', async () => {
    stubEngage({ ref: 'fresh-ref', flowResult: {} });
    const req = makeRequest({ path: '/' });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);

    const setCookies = res.getHeader('Set-Cookie');
    const bid = setCookies.find((c) => c.startsWith(`${BID_COOKIE}=`));
    assert.ok(bid, 'bid Set-Cookie present');
    assert.ok(bid.includes('fresh-ref'));
    assert.ok(bid.includes('Max-Age=31536000'));
    assert.ok(bid.includes('SameSite=None'));
    assert.ok(bid.includes('Secure'));
    assert.ok(bid.includes('Path=/'));
    assert.ok(!bid.includes('Domain=')); // COOKIE_DOMAIN empty in test config
  });

  it('does not set a bid cookie for returning visitors', async () => {
    stubEngage({ flowResult: { pageVariantId: 'Logged-In-Booked' } });
    const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);

    const setCookies = res.getHeader('Set-Cookie') || [];
    assert.equal(setCookies.some((c) => c.startsWith(`${BID_COOKIE}=`)), false);
  });

  it('sets the session gtm cookie (SameSite=Lax, no Max-Age) for personalized responses', async () => {
    stubEngage({ flowResult: { pageVariantId: 'Logged-In-Booked' } });
    const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);

    const gtm = res.getHeader('Set-Cookie').find((c) => c.startsWith('sc_personalize_gtm='));
    assert.ok(gtm, 'gtm Set-Cookie present');
    assert.ok(gtm.includes('SameSite=Lax'));
    assert.ok(!gtm.includes('Max-Age')); // session cookie
    const value = decodeURIComponent(gtm.slice('sc_personalize_gtm='.length, gtm.indexOf(';')));
    assert.equal(JSON.parse(value).experiences[0].variantId, 'Logged-In-Booked');
  });

  it('applies COOKIE_DOMAIN when configured', async () => {
    CONFIG.COOKIE_DOMAIN = '.carnival.com';
    stubEngage({ ref: 'fresh-ref', flowResult: {} });
    const req = makeRequest({ path: '/' });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);
    const bid = res.getHeader('Set-Cookie').find((c) => c.startsWith(`${BID_COOKIE}=`));
    assert.ok(bid.includes('Domain=.carnival.com'));
  });

  it('prefers the matched route cookieDomain over the global COOKIE_DOMAIN', async () => {
    CONFIG.COOKIE_DOMAIN = '.carnival.com';
    CONFIG.ROUTES[0].cookieDomain = '.carnival.com.au';
    stubEngage({ ref: 'fresh-ref', flowResult: { pageVariantId: 'AU-Var-One' } });
    const req = makeRequest({ host: AU_HOST, path: '/' });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);
    const cookies = res.getHeader('Set-Cookie');
    for (const cookie of cookies) assert.ok(cookie.includes('Domain=.carnival.com.au'), cookie);
    assert.equal(cookies.length, 2); // bid + gtm
  });

  it('sets no cookies on un-personalized pass-through responses', () => {
    const req = makeRequest({ path: '/anything' });
    const res = makeResponse();
    onClientResponse(req, res);
    assert.equal(res.getHeader('Set-Cookie'), undefined);
  });

  it('echoes the bucket only when DEBUG is on and the request opts in', async () => {
    stubEngage({ flowResult: { pageVariantId: 'Logged-In-Booked' } });
    const req = makeRequest({
      path: '/',
      headers: { Cookie: `${BID_COOKIE}=abc`, 'x-ew-pz-debug': '1' },
    });
    await onClientRequest(req);

    const res = makeResponse();
    onClientResponse(req, res);
    assert.equal(res.getHeader('x-ew-pz-bucket')[0], 'logged-in-booked');

    // Same request without the debug header: no echo.
    const req2 = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
    stubEngage({ flowResult: { pageVariantId: 'Logged-In-Booked' } });
    await onClientRequest(req2);
    const res2 = makeResponse();
    onClientResponse(req2, res2);
    assert.equal(res2.getHeader('x-ew-pz-bucket'), undefined);
  });
});

// The exact response captured live from the nonprod tenant's "CC Home Page
// Model" flow (trimmed to the relevant nodes) for a visitor with the cclUser
// cookie. The winning variant is outputs[].pageVariantId on the decisionTable
// node; the anonymous response is the same with outputs: [].
const REAL_FLOW_RESPONSE = {
  results: {
    decisionModelName: 'CC Home Page Model - 1CBA295A-6870-4D98-B706-739624749BB7',
    decisionModelRef: '07d87563-7d5e-4ea9-8a05-3c2f32dc9392',
    decisionModelVariantName: 'v2',
    error: false,
    debug: { bucket: '118', logs: 'false\ncclUser\nCarnivalUserBookingCookie\ncclCH\n' },
    decisionModelResultNodes: [
      {
        id: 'e45127f6-3ee2-4dfa-8d31-6b93a3723378',
        name: 'Map Page Variant',
        error: false,
        type: 'decisionTable',
        outputs: [{ ruleId: 'MapPageVariant_3', pageVariantId: 'Logged-In-Non-Booked' }],
      },
      {
        id: 'e12dde48-7fa8-4c3f-9c53-a8f9f3038b02',
        name: 'PageView',
        error: false,
        type: 'programmable',
        outputs: [{ PageView: 'false' }],
      },
    ],
  },
};

describe('flow result parsing', () => {
  it('extracts the variant from the real captured flow response (outputs[].pageVariantId)', async () => {
    stubEngage({ flowResult: REAL_FLOW_RESPONSE });
    const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc; cclUser=1` } });
    await onClientRequest(req);
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'logged-in-non-booked');
    assert.equal(req.__routed[0].path, '/Page%20Variants/Logged-In-Non-Booked');
  });

  it('serves default for the real anonymous response (decisionTable outputs empty)', async () => {
    const anon = JSON.parse(JSON.stringify(REAL_FLOW_RESPONSE));
    anon.results.decisionModelResultNodes[0].outputs = [];
    stubEngage({ flowResult: anon });
    const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
    await onClientRequest(req);
    assert.equal(req.__variables.PMUSER_EW_BUCKET, 'default');
    assert.equal(req.__routed.length, 0);
  });

  const shapes = [
    ['top-level variantId', { variantId: 'Logged-In-Booked' }],
    ['pageVariantId fallback', { pageVariantId: 'Logged-In-Booked' }],
    ['variantIds array', { variantIds: ['Logged-In-Booked', 'Other'] }],
    ['variantIds object', { variantIds: { a: 'Logged-In-Booked' } }],
    [
      'decisionModelResultNodes outputs',
      { results: { decisionModelResultNodes: [{ outputs: [{ variantId: 'Logged-In-Booked' }] }] } },
    ],
  ];

  for (const [name, flowResult] of shapes) {
    it(`extracts the variant from ${name}`, async () => {
      stubEngage({ flowResult });
      const req = makeRequest({ path: '/', headers: { Cookie: `${BID_COOKIE}=abc` } });
      await onClientRequest(req);
      assert.equal(req.__variables.PMUSER_EW_BUCKET, 'logged-in-booked');
    });
  }
});
