// Structural validation of the shipped config.js — run this after editing the
// config and before deploying. It checks shape, not values, so TODO
// placeholders pass; the deploy checklist in the README covers filling them in.
// (Runs in its own process, so main.test.js's config overrides don't leak here.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import CONFIG from '../config.js';

describe('config.js structure', () => {
  it('has the global settings the worker reads', () => {
    assert.equal(typeof CONFIG.ENABLED, 'boolean');
    assert.ok(typeof CONFIG.CLIENT_KEY === 'string' && CONFIG.CLIENT_KEY.length > 0);
    assert.ok(/^(\/|https:\/\/)/.test(CONFIG.ENGAGE_API_BASE), 'ENGAGE_API_BASE must be a path on this property or an https URL');
    assert.ok(typeof CONFIG.CHANNEL === 'string' && CONFIG.CHANNEL.length > 0);
    assert.ok(CONFIG.BROWSER_CREATE_TIMEOUT_MS > 0);
    assert.ok(CONFIG.CALLFLOWS_TIMEOUT_MS > 0);
    assert.ok(CONFIG.BID_COOKIE_EXPIRY_DAYS > 0);
    assert.ok(typeof CONFIG.GTM_COOKIE_NAME === 'string' && CONFIG.GTM_COOKIE_NAME.length > 0);
    assert.ok(
      CONFIG.CACHE_KEY_VARIABLE.startsWith('PMUSER_'),
      'user-defined Property Manager variables must be prefixed PMUSER_'
    );
    assert.ok(typeof CONFIG.DEFAULT_BUCKET === 'string' && CONFIG.DEFAULT_BUCKET.length > 0);
    assert.ok(CONFIG.MAX_COOKIE_PARAM_VALUE_BYTES > 0);
    assert.ok(CONFIG.MAX_COOKIE_PARAMS_TOTAL_BYTES > 0);
    for (const key of ['bid', 'gtm', 'bucket', 'originSkip', 'debug']) {
      assert.ok(
        typeof CONFIG.HEADERS[key] === 'string' && CONFIG.HEADERS[key].length > 0,
        `HEADERS.${key} missing`
      );
    }
  });

  it('has at least one route and every route is well-formed', () => {
    assert.ok(Array.isArray(CONFIG.ROUTES) && CONFIG.ROUTES.length > 0);

    for (const [i, route] of CONFIG.ROUTES.entries()) {
      const label = `ROUTES[${i}]`;
      assert.ok(Array.isArray(route.hosts), `${label}.hosts must be an array`);
      for (const host of route.hosts) {
        assert.equal(host, host.toLowerCase(), `${label}.hosts entries must be lowercase`);
      }
      assert.ok(
        Array.isArray(route.paths) && route.paths.length > 0,
        `${label}.paths must be a non-empty array`
      );
      for (const path of route.paths) {
        assert.ok(path.startsWith('/'), `${label} path '${path}' must start with '/'`);
      }
      if (route.originPath !== undefined) {
        assert.ok(route.originPath.startsWith('/'), `${label}.originPath must start with '/'`);
      }
      assert.ok(
        typeof route.friendlyId === 'string' && route.friendlyId.length > 0,
        `${label}.friendlyId missing`
      );
      // The Engage API rejects anything else with a 400 (verified empirically:
      // friendlyId must match ^[a-z0-9_]*$), so catch it before deploy.
      assert.match(
        route.friendlyId,
        /^[a-z0-9_]+$/,
        `${label}.friendlyId '${route.friendlyId}' must be lowercase [a-z0-9_] — the Engage API rejects anything else`
      );
      if (route.cookieDomain !== undefined) {
        assert.ok(
          typeof route.cookieDomain === 'string' && route.cookieDomain.length > 0,
          `${label}.cookieDomain must be a non-empty string when present`
        );
      }
      assert.ok(Array.isArray(route.allowedVariants), `${label}.allowedVariants must be an array`);
      for (const variant of route.allowedVariants) {
        assert.ok(
          typeof variant === 'string' && variant.length > 0,
          `${label}.allowedVariants entries must be non-empty strings`
        );
      }
      for (const key of ['pointOfSale', 'currency', 'language']) {
        assert.ok(
          typeof route.market?.[key] === 'string' && route.market[key].length > 0,
          `${label}.market.${key} missing`
        );
      }
      if (route.selectedCurrencyMarkets !== undefined) {
        for (const [currency, market] of Object.entries(route.selectedCurrencyMarkets)) {
          assert.equal(currency, currency.toUpperCase(), `${label} currency keys must be uppercase`);
          assert.ok(market.pointOfSale && market.currency, `${label}.selectedCurrencyMarkets.${currency} needs pointOfSale + currency`);
        }
      }
    }
  });

  it('keeps host-filtered routes before catch-all routes (first match wins)', () => {
    const firstCatchAll = CONFIG.ROUTES.findIndex((r) => r.hosts.length === 0);
    if (firstCatchAll === -1) return;
    for (let i = firstCatchAll + 1; i < CONFIG.ROUTES.length; i++) {
      const paths = new Set(CONFIG.ROUTES[firstCatchAll].paths.map((p) => p.toLowerCase()));
      const shadowed = CONFIG.ROUTES[i].paths.some((p) => paths.has(p.toLowerCase()));
      assert.ok(
        !CONFIG.ROUTES[i].hosts.length || !shadowed,
        `ROUTES[${i}] is host-filtered but listed after a catch-all route with the same path — it can never match`
      );
    }
  });
});
