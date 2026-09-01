/**
 * Sitecore Personalize page-variant bucketing at the Akamai edge.
 *
 * Flow (mirrors src/lib/engage/personalize/custom/customPersonalizeMiddleware.ts):
 *  1. onClientRequest runs BEFORE cache lookup on every request to a configured route.
 *  2. Ensure the visitor has a CDP browser id (bid_<clientKey> cookie; create
 *     one via GET /v1.2/browser/create.json when missing).
 *  3. POST /v2/callFlows with the same inputs the middleware sends. The flow
 *     returns the visitor's bucket (page variant id).
 *  4. Rewrite the forward (origin) request to `${path}/Page Variants/${variantId}`.
 *     request.route() changes are NOT part of the cache key, so the bucket is
 *     added to the key via the PMUSER_EW_BUCKET variable instead — Akamai keeps
 *     one cached copy per bucket while the client-facing URL never changes.
 *  5. onClientResponse (cache hits included) sets the bid cookie for new
 *     visitors and the sc_personalize_gtm cookie consumed by PersonalizeGtmSync.
 *
 * Any error, timeout or unexpected flow output fails open: the visitor gets the
 * default (non-personalized) page, cached under the 'default' bucket. Neither
 * handler ever throws.
 */
import { httpRequest } from 'http-request';
import { logger } from 'log';
import { Cookies, SetCookie } from 'cookies';
import URLSearchParams from 'url-search-params';
import CONFIG from './config.js';

const H = CONFIG.HEADERS;

/* --------------------------------- helpers -------------------------------- */

/** First value of a request header, or undefined. */
function firstHeader(request, name) {
  const values = request.getHeader(name);
  return values && values.length > 0 ? values[0] : undefined;
}

/** Lowercases and strips trailing slashes; '' collapses to '/'. */
function normalizePath(path) {
  const p = (path || '/').toLowerCase().replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** Variant name normalization used for comparisons and the bucket value:
 *  spaces -> dashes, lowercase — same as the middleware. */
function normalizeVariantId(variantId) {
  return (variantId || '').split(' ').join('-').toLowerCase();
}

/** First CONFIG.ROUTES entry matching the request, or undefined.
 *  First match wins — keep host-filtered routes before catch-all ones. */
function matchRoute(host, path) {
  const h = (host || '').toLowerCase();
  const p = normalizePath(path);
  return CONFIG.ROUTES.find(
    (route) =>
      (!route.hosts || route.hosts.length === 0 || route.hosts.indexOf(h) !== -1) &&
      route.paths.some((rp) => normalizePath(rp) === p)
  );
}

/**
 * The route's market (pointOfSale / currency / language). When the route
 * declares selectedCurrencyMarkets, the visitor's SelectedCurrency cookie
 * (AU currency dropdown: AUD | NZD) overrides POS + currency — mirrors
 * getPersonalizeContext().
 */
function getMarket(route, cookieMap) {
  const overrides = route.selectedCurrencyMarkets;
  if (overrides) {
    const selected = (cookieMap[CONFIG.SELECTED_CURRENCY_COOKIE] || '').trim().toUpperCase();
    if (overrides[selected]) return Object.assign({}, route.market, overrides[selected]);
  }
  return route.market;
}

/** Query string -> plain object, last value wins — matches
 *  Object.fromEntries(new URLSearchParams(qs)) in the middleware. */
function parseQuery(qs) {
  const map = {};
  if (!qs) return map;
  for (const entry of new URLSearchParams(qs).entries()) map[entry[0]] = entry[1];
  return map;
}

/** Cookie header -> name/value object. A malformed Cookie header is handled by
 *  the handlers' outer fail-open catch (default bucket). */
function cookiesToMap(request) {
  const map = {};
  const cookies = new Cookies(request.getHeader('Cookie') || undefined);
  for (const name of cookies.names()) {
    const value = cookies.get(name);
    if (value !== undefined) map[name] = value;
  }
  return map;
}

/** Mirrors the middleware's isPrefetch() guard so browser/router prefetches
 *  don't execute experiences (keeps experiment metrics accurate). */
function isPrefetch(request) {
  return (
    firstHeader(request, 'purpose') === 'prefetch' ||
    (firstHeader(request, 'sec-purpose') || '').indexOf('prefetch') > -1 ||
    firstHeader(request, 'next-router-prefetch') === '1' ||
    firstHeader(request, 'x-moz') === 'prefetch'
  );
}

/**
 * Flattened `params` object for callFlows: referrer + utm_* + qs_* + cookies_*,
 * matching the middleware's getExperienceParams() + getVariantByPageId()
 * expansion + the Engage SDK's flattenObject() with '_' separators. Cookie
 * params are size-capped to bound the sub-request body.
 */
function buildExperienceParams(request, query, cookieMap) {
  const params = {};

  // NextRequest.referrer defaults to 'about:client' when no referer header is present.
  params.referrer = firstHeader(request, 'referer') || 'about:client';

  for (const key of ['campaign', 'content', 'medium', 'source']) {
    const value = query['utm_' + key];
    if (value !== undefined) params['utm_' + key] = value;
  }

  for (const key of Object.keys(query)) {
    params['qs_' + key] = query[key];
  }

  let budget = CONFIG.MAX_COOKIE_PARAMS_TOTAL_BYTES;
  for (const name of Object.keys(cookieMap)) {
    const value = cookieMap[name];
    if (value.length > CONFIG.MAX_COOKIE_PARAM_VALUE_BYTES) continue;
    budget -= name.length + value.length;
    if (budget < 0) break;
    params['cookies_' + name] = value;
  }

  return params;
}

/**
 * Winning variant id from a callFlows result, '' when unassigned.
 *
 * The REAL response shape (verified live against the "CC Home Page Model" flow,
 * Sep 2026) nests the variant in the decision-table node's outputs:
 *   { results: { decisionModelResultNodes: [
 *       { name: 'Map Page Variant', type: 'decisionTable',
 *         outputs: [{ ruleId: '...', pageVariantId: 'Logged-In-Non-Booked' }] }, ... ] } }
 * with outputs [] when the visitor is left unassigned. The other keys
 * (variantIds, variantId, top-level pageVariantId, outputs[].variantId /
 * pageVariant) are kept for parity with the middleware's tolerant parsing.
 */
function extractVariantId(result) {
  if (!result || typeof result !== 'object') return '';
  const ids = [];

  const topLevel = result.variantIds;
  if (Array.isArray(topLevel)) {
    ids.push(...topLevel);
  } else if (topLevel && typeof topLevel === 'object') {
    for (const value of Object.values(topLevel)) {
      if (typeof value === 'string' && value.length > 0) ids.push(value);
    }
  }

  if (result.variantId) ids.push(result.variantId);

  const nodes = (result.results && result.results.decisionModelResultNodes) || [];
  for (const node of nodes) {
    for (const output of node.outputs || []) {
      if (!output) continue;
      if (output.variantId) ids.push(output.variantId);
      if (output.pageVariantId) ids.push(output.pageVariantId);
      if (output.pageVariant) ids.push(output.pageVariant);
    }
  }

  const unique = [...new Set(ids.map((id) => String(id).trim()).filter((id) => id.length > 0))];
  const pageVariantId =
    typeof result.pageVariantId === 'string' ? result.pageVariantId.trim() : '';
  return unique[0] || pageVariantId || '';
}

/* --------------------------- Engage sub-requests --------------------------- */

function engageUrl(pathAndQuery) {
  const base = CONFIG.ENGAGE_API_BASE.endsWith('/')
    ? CONFIG.ENGAGE_API_BASE.slice(0, -1)
    : CONFIG.ENGAGE_API_BASE;
  return base + pathAndQuery;
}

/** New CDP browser ref (the value of the bid_<clientKey> cookie), undefined on
 *  any failure. Mirrors @sitecore/engage getBrowserIdFromCdp(). */
async function createBrowserRef() {
  try {
    const url = engageUrl(
      `/v1.2/browser/create.json?client_key=${encodeURIComponent(CONFIG.CLIENT_KEY)}&message=%7B%7D`
    );
    const res = await httpRequest(url, {
      method: 'GET',
      headers: { 'X-Library-Version': CONFIG.LIBRARY_VERSION },
      timeout: CONFIG.BROWSER_CREATE_TIMEOUT_MS,
    });
    // The live API answers 201 Created (verified against the real endpoint) —
    // accept any 2xx like the Engage SDK does.
    if (res.status < 200 || res.status >= 300) {
      logger.error(`pz: browser/create returned ${res.status}`);
      return undefined;
    }
    const data = await res.json();
    return data && typeof data.ref === 'string' && data.ref.length > 0 ? data.ref : undefined;
  } catch (err) {
    logger.error(`pz: browser/create failed: ${err.message}`);
    return undefined;
  }
}

/** POST /v2/callFlows; parsed flow result, or null on any failure. Body shape
 *  mirrors @sitecore/engage Personalizer.mapPersonalizeInputToCDPData(). */
async function executeFlow(body) {
  try {
    const res = await httpRequest(engageUrl('/v2/callFlows'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Library-Version': CONFIG.LIBRARY_VERSION,
      },
      body: JSON.stringify(body),
      timeout: CONFIG.CALLFLOWS_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      logger.error(`pz: callFlows returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.error(`pz: callFlows failed: ${err.message}`);
    return null;
  }
}

/* -------------------------------- handlers -------------------------------- */

export async function onClientRequest(request) {
  try {
    // Never trust inbound copies of our internal state headers — a client could
    // otherwise have onClientResponse set attacker-controlled cookies.
    request.removeHeader(H.bid);
    request.removeHeader(H.gtm);
    request.removeHeader(H.bucket);
    request.removeHeader(H.reason);

    if (!CONFIG.ENABLED) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') return;

    // Allow-list routing: only routes in CONFIG.ROUTES are personalized;
    // everything else passes through untouched.
    const route = matchRoute(request.host, request.path);
    if (!route) return;

    // Every request on a personalized route gets the bucket cache-key
    // dimension, so hits and misses use a consistent key space.
    let bucket = CONFIG.DEFAULT_BUCKET;
    request.setVariable(CONFIG.CACHE_KEY_VARIABLE, bucket);
    request.cacheKey.includeVariable(CONFIG.CACHE_KEY_VARIABLE);

    // Tell the origin middleware personalization is handled at the edge —
    // otherwise a cache miss would produce per-user markup that poisons the
    // shared cache entry for the bucket.
    request.setHeader(H.originSkip, '1');

    if (isPrefetch(request)) {
      // Serve the default bucket without executing an experience.
      request.setHeader(H.bucket, bucket);
      request.setHeader(H.reason, 'prefetch');
      return;
    }

    const cookieMap = cookiesToMap(request);
    const query = parseQuery(request.query);
    let browserId = cookieMap['bid_' + CONFIG.CLIENT_KEY];
    let browserIdIsNew = false;

    // Debug triage code echoed by onClientResponse (see CONFIG.DEBUG).
    let reason = 'flow-unassigned';
    let variantId = '';
    const pvOverride = query[CONFIG.TEST_VARIANT_QUERY_PARAM];
    if (pvOverride !== undefined && pvOverride !== '') {
      // Test mode (?pv=<variant>), mirroring getVariantByPageId().
      variantId = pvOverride;
      reason = 'pv-override';
    } else {
      if (!browserId) {
        browserId = await createBrowserRef();
        browserIdIsNew = Boolean(browserId);
      }
      if (!browserId) {
        logger.error('pz: no browser id available, serving default bucket');
        request.setHeader(H.bucket, bucket);
        request.setHeader(H.reason, 'no-browser-id');
        return;
      }

      const market = getMarket(route, cookieMap);
      const flowResult = await executeFlow({
        channel: CONFIG.CHANNEL,
        clientKey: CONFIG.CLIENT_KEY,
        currencyCode: market.currency,
        friendlyId: route.friendlyId,
        language: market.language,
        params: buildExperienceParams(request, query, cookieMap),
        pointOfSale: market.pointOfSale,
        browserId,
      });
      if (flowResult === null) reason = 'flow-error';
      variantId = extractVariantId(flowResult);
    }

    variantId = (variantId || '').trim();

    // Validate against the route's variant list — the edge equivalent of the
    // middleware's activePageVariants check. An unlisted variant would cache a
    // 404 for the whole bucket, so it serves the default page instead.
    const normalized = normalizeVariantId(variantId);
    const allowed = (route.allowedVariants || []).map(normalizeVariantId);
    const isValidVariant =
      variantId.length > 0 && (allowed.length === 0 || allowed.indexOf(normalized) !== -1);

    if (variantId.length > 0 && !isValidVariant) {
      reason = reason === 'pv-override' ? 'pv-invalid' : 'flow-unknown-variant';
    }
    if (isValidVariant) {
      if (reason !== 'pv-override') reason = 'flow';
      bucket = normalized;
      request.setVariable(CONFIG.CACHE_KEY_VARIABLE, bucket);

      // `${basePath}/Page Variants/${variantId}` — identical to the middleware
      // rewrite. originPath covers properties whose client-facing path differs
      // from the origin route (see config.js).
      const basePath = (route.originPath || request.path).replace(/\/+$/, '');
      request.route({
        path:
          basePath +
          '/' +
          encodeURIComponent(CONFIG.PAGE_VARIANTS_SEGMENT) +
          '/' +
          encodeURIComponent(variantId),
      });

      // Payload for the sc_personalize_gtm cookie, set in onClientResponse.
      request.setHeader(
        H.gtm,
        encodeURIComponent(
          JSON.stringify({
            browserId,
            experiences: [{ friendlyId: route.friendlyId, variantId, type: 'page' }],
          })
        )
      );
    }

    request.setHeader(H.bucket, bucket);
    request.setHeader(H.reason, reason);
    // Only set for NEW visitors — the presence of this header is what tells
    // onClientResponse to emit the bid Set-Cookie.
    if (browserIdIsNew && browserId) request.setHeader(H.bid, browserId);
  } catch (err) {
    // Fail open: the visitor gets the default page under the 'default' bucket.
    try {
      logger.error(`pz: onClientRequest failed: ${err.message}`);
      request.setHeader(H.reason, 'error');
    } catch (e) {
      // ignore
    }
  }
}

export function onClientResponse(request, response) {
  try {
    const bid = firstHeader(request, H.bid);
    const gtm = firstHeader(request, H.gtm);

    // US and AU are different registrable domains, so the Domain attribute is
    // per-route (route.cookieDomain), falling back to the global setting.
    const route = matchRoute(request.host, request.path);
    const cookieDomain = (route && route.cookieDomain) || CONFIG.COOKIE_DOMAIN;

    // New visitor: persist the CDP browser id exactly like
    // EngageServer.handleCookie() (365 days, SameSite=None; Secure) so
    // client-side events reuse the same guest.
    if (bid) {
      const bidCookie = new SetCookie({
        name: 'bid_' + CONFIG.CLIENT_KEY,
        value: bid,
        path: '/',
        maxAge: CONFIG.BID_COOKIE_EXPIRY_DAYS * 86400,
        sameSite: 'None',
        secure: true,
      });
      if (cookieDomain) bidCookie.domain = cookieDomain;
      response.addHeader('Set-Cookie', bidCookie.toHeader());
    }

    // Session cookie consumed (and cleared) by PersonalizeGtmSync on the
    // client. Value is URL-encoded JSON; the component decodes before JSON.parse.
    if (gtm) {
      const gtmCookie = new SetCookie({
        name: CONFIG.GTM_COOKIE_NAME,
        value: gtm,
        path: '/',
        sameSite: 'Lax',
      });
      if (cookieDomain) gtmCookie.domain = cookieDomain;
      response.addHeader('Set-Cookie', gtmCookie.toHeader());
    }

    if (CONFIG.DEBUG && firstHeader(request, H.debug)) {
      response.setHeader('x-ew-pz-bucket', firstHeader(request, H.bucket) || '');
      response.setHeader('x-ew-pz-reason', firstHeader(request, H.reason) || '');
    }
  } catch (err) {
    try {
      logger.error(`pz: onClientResponse failed: ${err.message}`);
    } catch (e) {
      // ignore
    }
  }
}
