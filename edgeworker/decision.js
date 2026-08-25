/**
 * Personalization decision helpers.
 * Each function mirrors a piece of the Next.js middleware so the flow in
 * Sitecore Personalize receives exactly the same inputs from the edge as it
 * does from the origin middleware today.
 */
import CONFIG from './config.js';

/** Returns the first value of a request header, or undefined. */
export function firstHeader(request, name) {
  const values = request.getHeader(name);
  return values && values.length > 0 ? values[0] : undefined;
}

/**
 * Parses a raw query string into a plain object (last value wins),
 * matching Object.fromEntries(new URLSearchParams(qs)) in the middleware.
 * @param {string|undefined} qs query string without the leading '?'
 */
export function parseQuery(qs) {
  const map = {};
  if (!qs) return map;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      map[decodeURIComponent(rawKey.split('+').join(' '))] = decodeURIComponent(
        rawValue.split('+').join(' ')
      );
    } catch (e) {
      map[rawKey] = rawValue;
    }
  }
  return map;
}

/**
 * Converts an EdgeWorkers Cookies jar into a name -> value object,
 * matching Object.fromEntries(req.cookies.getAll()...) in the middleware.
 */
export function cookiesToMap(cookies) {
  const map = {};
  if (!cookies) return map;
  for (const name of cookies.names()) {
    const value = cookies.get(name);
    if (value !== undefined) map[name] = value;
  }
  return map;
}

/** Lowercases and strips trailing slashes; '' collapses to '/'. */
export function normalizePath(path) {
  const p = (path || '/').toLowerCase().replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/**
 * Finds the first configured route matching the request. Host filter is
 * optional; paths are compared case-insensitively without a trailing slash.
 * @returns the matching CONFIG.ROUTES entry, or undefined
 */
export function matchRoute(host, path) {
  const normalizedHost = (host || '').toLowerCase();
  const normalizedPath = normalizePath(path);
  return CONFIG.ROUTES.find((route) => {
    if (route.hosts && route.hosts.length > 0 && route.hosts.indexOf(normalizedHost) === -1) {
      return false;
    }
    return route.paths.some((p) => normalizePath(p) === normalizedPath);
  });
}

/**
 * Resolves point of sale / currency / 2-letter language from the locale path
 * segment and the SelectedCurrency cookie. Mirrors getPersonalizeContext():
 * en-AU honours SelectedCurrency (AUD|NZD), everything else maps by locale.
 */
export function getMarketContext(path, cookieMap) {
  const knownLocales = Object.keys(CONFIG.LOCALE_MARKET_MAP);
  const firstSegment = (path || '/').split('/').filter(Boolean)[0] || '';
  const locale =
    knownLocales.find((l) => l.toLowerCase() === firstSegment.toLowerCase()) ||
    CONFIG.DEFAULT_LOCALE;

  let market;
  if (locale === CONFIG.AU_LOCALE) {
    const selected = (cookieMap[CONFIG.SELECTED_CURRENCY_COOKIE] || '').trim().toUpperCase();
    market = CONFIG.AU_CURRENCY_MARKET_MAP[selected] || CONFIG.LOCALE_MARKET_MAP[CONFIG.AU_LOCALE];
  } else {
    market =
      CONFIG.LOCALE_MARKET_MAP[locale] || CONFIG.LOCALE_MARKET_MAP[CONFIG.DEFAULT_LOCALE];
  }

  const personalizeLanguage = (locale.split('-')[0] || locale).toLowerCase().slice(0, 2);
  return {
    pointOfSale: market.pointOfSale,
    currency: market.currency,
    personalizeLanguage,
  };
}

/**
 * Builds the flattened `params` object for callFlows. Matches what the
 * middleware produces after CustomPersonalizeMiddleware.getExperienceParams()
 * (referrer + utm + qs + cookies), getVariantByPageId()'s qs_ and cookies_
 * expansion, and the Engage SDK's flattenObject() with '_' separators.
 */
export function buildExperienceParams(request, query, cookieMap) {
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
 * Extracts the winning variant id from a callFlows result. Mirrors
 * getVariantIdsFromPersonalizeResult() plus the pageVariantId fallback in
 * CustomPersonalizeMiddleware.personalize().
 * @returns {string} the variant id, or '' when none was returned
 */
export function extractVariantId(result) {
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
      if (output && output.variantId) ids.push(output.variantId);
    }
  }

  const unique = [
    ...new Set(ids.map((id) => String(id).trim()).filter((id) => id.length > 0)),
  ];
  const pageVariantId =
    typeof result.pageVariantId === 'string' ? result.pageVariantId.trim() : '';
  return unique[0] || pageVariantId || '';
}

/** Variant name normalization used for comparisons: spaces -> dashes, lowercase. */
export function normalizeVariantId(variantId) {
  return (variantId || '').split(' ').join('-').toLowerCase();
}
