/**
 * Sitecore Personalize bucketing at the Akamai edge.
 *
 * Flow (mirrors src/lib/engage/personalize/custom/customPersonalizeMiddleware.ts):
 *  1. onClientRequest runs BEFORE cache lookup on every request to a configured route.
 *  2. Ensure the visitor has a CDP browser id (bid_<clientKey> cookie; create one
 *     via /v1.2/browser/create.json when missing).
 *  3. POST /v2/callFlows with the same inputs the middleware sends. The flow
 *     returns the visitor's bucket (page variant id).
 *  4. Rewrite the forward (origin) request to the bucket's unique URL:
 *     `${path}/Page Variants/${variantId}` and add the bucket to the cache key
 *     via a PMUSER variable, so Akamai keeps one cached copy per bucket while
 *     the client-facing URL stays `/`.
 *  5. onClientResponse (cache hits included) sets the bid cookie for new
 *     visitors and the sc_personalize_gtm cookie consumed by PersonalizeGtmSync.
 *
 * Any error, timeout or unexpected flow output fails open: the visitor gets the
 * default (non-personalized) page, cached under the 'default' bucket.
 */
import { logger } from 'log';
import { Cookies, SetCookie } from 'cookies';
import CONFIG from './config.js';
import { createBrowserRef, executeFlow } from './engage-client.js';
import {
  buildExperienceParams,
  cookiesToMap,
  extractVariantId,
  firstHeader,
  getMarketContext,
  matchRoute,
  normalizeVariantId,
  parseQuery,
} from './decision.js';

const H = CONFIG.HEADERS;

function safeCookies(request) {
  try {
    return new Cookies(request.getHeader('Cookie') || undefined);
  } catch (e) {
    return null;
  }
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment);
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

export async function onClientRequest(request) {
  try {
    // Never trust inbound copies of our internal state headers.
    request.removeHeader(H.bid);
    request.removeHeader(H.bidNew);
    request.removeHeader(H.gtm);
    request.removeHeader(H.bucket);

    if (!CONFIG.ENABLED) return;
    if (request.method !== 'GET' && request.method !== 'HEAD') return;

    // Allow-list routing: only paths explicitly configured in CONFIG.ROUTES are
    // personalized; everything else passes through untouched.
    const route = matchRoute(request.host, request.path);
    if (!route) return;

    // Every request on a personalized route gets the bucket cache-key dimension,
    // so hits and misses use a consistent key space.
    let bucket = CONFIG.DEFAULT_BUCKET;
    request.setVariable(CONFIG.CACHE_KEY_VARIABLE, bucket);
    request.cacheKey.includeVariable(CONFIG.CACHE_KEY_VARIABLE);

    // Tell the origin middleware personalization is handled at the edge, for
    // hits on the default bucket as well — otherwise the origin would produce
    // per-user markup that poisons the shared cache entry.
    request.setHeader(H.originSkip, '1');

    if (isPrefetch(request)) {
      // Serve the default bucket without executing an experience.
      request.setHeader(H.bucket, bucket);
      return;
    }

    const cookies = safeCookies(request);
    const cookieMap = cookiesToMap(cookies);
    const query = parseQuery(request.query);
    const bidCookieName = 'bid_' + CONFIG.CLIENT_KEY;
    let browserId = cookieMap[bidCookieName];
    let browserIdIsNew = false;

    let variantId = '';
    const pvOverride = query[CONFIG.TEST_VARIANT_QUERY_PARAM];
    if (pvOverride !== undefined && pvOverride !== '') {
      // Test mode (?pv=<variant>), mirroring getVariantByPageId().
      variantId = pvOverride;
    } else {
      if (!browserId) {
        browserId = await createBrowserRef();
        browserIdIsNew = Boolean(browserId);
      }
      if (!browserId) {
        logger.error('pz: no browser id available, serving default bucket');
        request.setHeader(H.bucket, bucket);
        return;
      }

      const market = getMarketContext(request.path, cookieMap);
      const flowResult = await executeFlow({
        channel: CONFIG.CHANNEL,
        clientKey: CONFIG.CLIENT_KEY,
        currencyCode: market.currency,
        friendlyId: route.friendlyId,
        language: market.personalizeLanguage,
        params: buildExperienceParams(request, query, cookieMap),
        pointOfSale: market.pointOfSale,
        browserId,
      });
      variantId = extractVariantId(flowResult);
    }

    variantId = (variantId || '').trim();

    // Validate against the configured variant list — the edge equivalent of the
    // middleware's check against activePageVariants from Experience Edge.
    const normalized = normalizeVariantId(variantId);
    const allowedNormalized = (route.allowedVariants || []).map(normalizeVariantId);
    const isValidVariant =
      variantId.length > 0 &&
      (allowedNormalized.length === 0 || allowedNormalized.indexOf(normalized) !== -1);

    if (isValidVariant) {
      bucket = normalized;
      request.setVariable(CONFIG.CACHE_KEY_VARIABLE, bucket);

      // `${basePath}/Page Variants/${variantId}` — identical to the middleware rewrite.
      const basePath = request.path.replace(/\/+$/, '');
      const forwardPath =
        basePath +
        '/' +
        encodePathSegment(CONFIG.PAGE_VARIANTS_SEGMENT) +
        '/' +
        encodePathSegment(variantId);
      request.route({ path: forwardPath });

      // Payload for the sc_personalize_gtm cookie, set in onClientResponse.
      const gtmPayload = {
        browserId,
        experiences: [{ friendlyId: route.friendlyId, variantId, type: 'page' }],
      };
      request.setHeader(H.gtm, encodeURIComponent(JSON.stringify(gtmPayload)));
    }

    request.setHeader(H.bucket, bucket);
    if (browserIdIsNew && browserId) {
      request.setHeader(H.bid, browserId);
      request.setHeader(H.bidNew, '1');
    }
  } catch (err) {
    // Fail open: the visitor gets the default page under the 'default' bucket.
    try {
      logger.error(`pz: onClientRequest failed: ${err.message}`);
    } catch (e) {
      // ignore
    }
  }
}

export function onClientResponse(request, response) {
  try {
    const bid = firstHeader(request, H.bid);
    const bidIsNew = firstHeader(request, H.bidNew) === '1';
    const gtm = firstHeader(request, H.gtm);

    // New visitor: persist the CDP browser id exactly like EngageServer.handleCookie()
    // (365 days, SameSite=None; Secure) so client-side events reuse the same guest.
    if (bidIsNew && bid) {
      const bidCookie = new SetCookie({
        name: 'bid_' + CONFIG.CLIENT_KEY,
        value: bid,
        path: '/',
        maxAge: CONFIG.BID_COOKIE_EXPIRY_DAYS * 86400,
        sameSite: 'None',
        secure: true,
      });
      if (CONFIG.COOKIE_DOMAIN) bidCookie.domain = CONFIG.COOKIE_DOMAIN;
      response.addHeader('Set-Cookie', bidCookie.toHeader());
    }

    // Session cookie consumed (and cleared) by PersonalizeGtmSync on the client.
    // Value is URL-encoded JSON; the component decodes before JSON.parse.
    if (gtm) {
      const gtmCookie = new SetCookie({
        name: CONFIG.GTM_COOKIE_NAME,
        value: gtm,
        path: '/',
        sameSite: 'Lax',
      });
      if (CONFIG.COOKIE_DOMAIN) gtmCookie.domain = CONFIG.COOKIE_DOMAIN;
      response.addHeader('Set-Cookie', gtmCookie.toHeader());
    }

    if (CONFIG.DEBUG && firstHeader(request, H.debug)) {
      response.setHeader('x-ew-pz-bucket', firstHeader(request, H.bucket) || '');
    }
  } catch (err) {
    try {
      logger.error(`pz: onClientResponse failed: ${err.message}`);
    } catch (e) {
      // ignore
    }
  }
}
