/**
 * Deployment configuration for the Sitecore Personalize EdgeWorker.
 *
 * Values mirror the Next.js middleware environment (src/lib/engage/*):
 *   CLIENT_KEY      -> NEXT_PUBLIC_ENGAGE_CLIENT_KEY
 *   ENGAGE_API_BASE -> NEXT_PUBLIC_ENGAGE_TARGET_URL (reached through Akamai, see README)
 *   CHANNEL         -> NEXT_PUBLIC_ENGAGE_CHANNEL
 *   COOKIE_DOMAIN   -> NEXT_PUBLIC_ENGAGE_COOKIE_DOMAIN
 */
export default {
  /** Master switch. false = every request passes through untouched. */
  ENABLED: true,

  /** Sitecore Personalize / CDP client key. */
  CLIENT_KEY: 'TODO_ENGAGE_CLIENT_KEY',

  /**
   * Base URL for the Engage/CDP API. EdgeWorkers sub-requests can only reach
   * hosts delivered by Akamai, so the default is a relative path on THIS
   * property; a Property Manager rule must match `/__engage/*`, swap the origin
   * to the Engage host (e.g. https://api-engage-us.sitecorecloud.io) and strip
   * the `/__engage` prefix. See README. An absolute https:// URL is also
   * accepted if that hostname is itself delivered by Akamai.
   */
  ENGAGE_API_BASE: '/__engage',

  /** Sent as X-Library-Version, matching @sitecore/engage used by the middleware. */
  LIBRARY_VERSION: '1.4.3',

  /** CDP channel. */
  CHANNEL: 'WEB',

  /**
   * Personalized routes. First match wins — keep host-filtered routes before
   * catch-all ones. Per route:
   * - hosts: Host-header filter (lowercase, exact match). [] = any host. Lets a
   *   single EdgeWorker serve several properties; when each property gets its
   *   own EdgeWorker + config, [] is fine.
   * - paths: exact client-facing request paths (compared lowercase, ignoring
   *   trailing slashes).
   * - originPath: optional. Set when the client-facing path differs from the
   *   forward path the property sends to the origin (clients request '/', the
   *   property forwards '/home' to the Next.js origin); the variant rewrite is
   *   then built from originPath instead of the request path.
   * - friendlyId: the page's Personalize experience friendly id — the value of
   *   the page item's `personalizedData` field in Sitecore (the same value the
   *   middleware reads via GraphQL and passes to callFlows). The Engage API
   *   only accepts ^[a-z0-9_]*$ (lowercase; verified empirically — it returns
   *   400 for anything else), so the Sitecore field value must match too.
   * - cookieDomain: Domain attribute for the bid/gtm cookies on this route
   *   (e.g. '.carnival.com' vs '.carnival.com.au'). Empty/absent = the global
   *   COOKIE_DOMAIN, and if that is empty too, host-only.
   * - allowedVariants: raw item names under the page's "Page Variants" folder.
   *   Replaces the middleware's runtime activePageVariants check. A variant the
   *   flow returns that is not listed serves the default page instead of caching
   *   a 404 for the whole bucket. [] = trust whatever the flow returns (NOT
   *   recommended). Update this list and redeploy when variants change in
   *   Sitecore.
   * - market: pointOfSale / currency / language sent to callFlows.
   * - selectedCurrencyMarkets: optional. When present, the visitor's
   *   SelectedCurrency cookie (set by the AU currency dropdown: AUD | NZD)
   *   overrides pointOfSale + currency, mirroring getPersonalizeContext().
   */
  ROUTES: [
    // AU homepage. Language is determined by the site (domain) — paths carry
    // no locale prefix, so the AU client path is '/' just like US; in Sitecore
    // the AU content is the en-AU language version of the same ccl-home site.
    // TODO (AU phase): confirm the AU property's forward path to the Next.js
    // origin (expected '/home', same as US) and uncomment originPath.
    {
      hosts: ['www.carnival.com.au'],
      paths: ['/'],
      // originPath: '/home',
      friendlyId: 'todo_au_homepage_friendly_id',
      // Placeholder: until real AU variant names are filled in, no flow output
      // can match, so the AU homepage safely serves the default bucket.
      allowedVariants: ['todo-au-variant-names'],
      cookieDomain: '.carnival.com.au',
      market: { pointOfSale: 'carnivalAU', currency: 'AUD', language: 'en' },
      selectedCurrencyMarkets: {
        AUD: { pointOfSale: 'carnivalAU', currency: 'AUD' },
        NZD: { pointOfSale: 'carnivalNZ', currency: 'NZD' },
      },
    },
    // US homepage. Clients request '/'; the property forwards '/home' to the
    // Next.js origin (decided Sep 2026, matching the nonprod mounting), so the
    // variant rewrite is built from '/home'. NOTE: URL paths resolve relative
    // to the site start item (/sitecore/content/home/homepage), so '/home' is
    // the item /sitecore/content/home/homepage/home (54BAEFE5-0F67-4B43-9003-
    // F3E5E87F1555) — a DIFFERENT item than '/' (the start item itself).
    // friendlyId, allowedVariants, and the Page Variants folder must come from
    // the item the FORWARD path resolves to: .../homepage/home.
    {
      hosts: ['www.carnival.com'],
      paths: ['/'],
      originPath: '/home',
      // Expected per the confirmed convention (personalizedData =
      // 'cc_page_<item-id>', as authored on the TST3 demo pages) for the item
      // '/home' resolves to ('home', 54BAEFE5-0F67-4B43-9003-F3E5E87F1555).
      // Verify with probes/probe-content.sh once the homepage is authored —
      // until the flow exists, callFlows answers "No flow executed" and the
      // worker serves the default bucket (fail-safe).
      friendlyId: 'cc_page_54baefe50f674b439003f3e5e87f1555',
      // Item names under the homepage's "Page Variants" folder — spelling must
      // match the Sitecore item names exactly. Not yet created in Sitecore
      // (nonprod activePageVariants was empty as of Sep 2026); these are the
      // planned names. Additional (including non-logged-in) variants are
      // planned; add them here and redeploy when they exist.
      cookieDomain: '.carnival.com',
      allowedVariants: [
        'Logged-In-Booked',
        'Logged-In-Courtesy-Hold',
        'Logged-In-Non-Booked',
        'Logged-In-Recently-Searched',
      ],
      market: { pointOfSale: 'carnivalUS', currency: 'USD', language: 'en' },
    },
  ],

  /** AU currency dropdown cookie consulted by selectedCurrencyMarkets. */
  SELECTED_CURRENCY_COOKIE: 'SelectedCurrency',

  /** URL segment of the variant child items; the rewrite is `${path}/Page Variants/${variantId}`. */
  PAGE_VARIANTS_SEGMENT: 'Page Variants',

  /** Query param that forces a variant, mirroring the middleware's `?pv=` test mode. */
  TEST_VARIANT_QUERY_PARAM: 'pv',

  /** Sub-request timeouts (ms). Fail open to the default page on expiry. */
  BROWSER_CREATE_TIMEOUT_MS: 1000,
  CALLFLOWS_TIMEOUT_MS: 1500,

  /** bid_<clientKey> cookie lifetime; middleware initServer() uses cookieExpiryDays: 365. */
  BID_COOKIE_EXPIRY_DAYS: 365,

  /**
   * Cookie Domain attribute (NEXT_PUBLIC_ENGAGE_COOKIE_DOMAIN, e.g.
   * '.carnival.com'). Empty = host-only. If one EdgeWorker serves properties on
   * different registrable domains (US + AU), leave empty.
   */
  COOKIE_DOMAIN: '',

  /** Cookie read by PersonalizeGtmSync on the client (URL-encoded JSON payload). */
  GTM_COOKIE_NAME: 'sc_personalize_gtm',

  /**
   * User-defined Property Manager variable used as the extra cache-key dimension.
   * MUST be declared in EVERY property this EdgeWorker runs on, or
   * request.setVariable() throws.
   */
  CACHE_KEY_VARIABLE: 'PMUSER_EW_BUCKET',

  /** Cache-key value for un-personalized traffic (no variant / errors / timeouts). */
  DEFAULT_BUCKET: 'default',

  /**
   * Internal request headers carrying per-request state from onClientRequest to
   * onClientResponse (works on cache hits too). They are also forwarded to
   * origin — `originSkip` intentionally so: the origin middleware must skip
   * personalization for edge-personalized requests (see README).
   */
  HEADERS: {
    bid: 'x-ew-pz-bid',
    gtm: 'x-ew-pz-gtm',
    bucket: 'x-ew-pz-bucket',
    reason: 'x-ew-pz-reason',
    originSkip: 'x-edge-personalize',
    debug: 'x-ew-pz-debug',
  },

  /**
   * Adds `x-ew-pz-bucket` and `x-ew-pz-reason` response headers when the
   * request carries HEADERS.debug — the primary production triage tool.
   * Reasons: flow | flow-unassigned | flow-unknown-variant | flow-error |
   * no-browser-id | pv-override | pv-invalid | prefetch | error.
   */
  DEBUG: true,

  /**
   * Size caps for the `cookies_*` params sent to callFlows (the middleware
   * forwards every request cookie; these keep the sub-request body bounded).
   * Cookies above the per-value cap are skipped.
   */
  MAX_COOKIE_PARAM_VALUE_BYTES: 1024,
  MAX_COOKIE_PARAMS_TOTAL_BYTES: 8192,
};
