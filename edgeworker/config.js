/**
 * Deployment configuration for the Sitecore Personalize EdgeWorker.
 *
 * The values mirror the Next.js middleware environment (see src/lib/engage/*).
 * Env-var equivalents from the origin app:
 *   CLIENT_KEY        -> NEXT_PUBLIC_ENGAGE_CLIENT_KEY
 *   ENGAGE_API_BASE   -> NEXT_PUBLIC_ENGAGE_TARGET_URL (reached through Akamai, see README)
 *   CHANNEL           -> NEXT_PUBLIC_ENGAGE_CHANNEL
 *   COOKIE_DOMAIN     -> NEXT_PUBLIC_ENGAGE_COOKIE_DOMAIN
 */
export default {
  /** Master switch. false = every request passes through untouched. */
  ENABLED: true,

  /** Sitecore Personalize / CDP client key (NEXT_PUBLIC_ENGAGE_CLIENT_KEY). */
  CLIENT_KEY: 'TODO_ENGAGE_CLIENT_KEY',

  /**
   * Base URL for the Engage/CDP API.
   * EdgeWorkers sub-requests can only reach hosts delivered by Akamai, so the
   * default is a relative path on THIS property; a Property Manager rule must
   * match `/__engage/*`, swap the origin to the Engage host
   * (NEXT_PUBLIC_ENGAGE_TARGET_URL, e.g. https://api-engage-us.sitecorecloud.io)
   * and strip the `/__engage` prefix. See README.md.
   * An absolute https:// URL is also accepted if that hostname is Akamaized.
   */
  ENGAGE_API_BASE: '/__engage',

  /** Sent as X-Library-Version, matching @sitecore/engage used by the middleware. */
  LIBRARY_VERSION: '1.4.3',

  /** CDP channel (NEXT_PUBLIC_ENGAGE_CHANNEL). */
  CHANNEL: 'WEB',

  /**
   * Personalized routes served from Akamai cache. First match wins.
   * - hosts: optional Host-header filter (lowercase, exact). Empty = any host.
   * - paths: exact request paths (lowercase, no trailing slash except '/').
   * - friendlyId: the Personalize experience friendly id for the page — the value
   *   of the page item's `personalizedData` field in Sitecore (the same value the
   *   middleware reads via GraphQL and passes to callFlows).
   * - allowedVariants: raw names of the page's variant items (children of the
   *   page's "Page Variants" folder). Replaces the middleware's runtime check
   *   against `activePageVariants` from Experience Edge. Empty array = trust
   *   whatever the flow returns (NOT recommended: a stale flow could route to a
   *   404 which would then be cached for the whole bucket).
   */
  ROUTES: [
    {
      hosts: [],
      paths: ['/'],
      friendlyId: 'TODO_HOMEPAGE_FRIENDLY_ID',
      // The four items under the homepage's "Page Variants" folder in Sitecore.
      // Spelling must match the item names exactly; normalizeVariantId() lowercases
      // them for the bucket value (e.g. 'Logged-In-Booked' -> 'logged-in-booked').
      // Every variant is a signed-in state, so a visitor without the `cclUser`
      // cookie cannot match any of them and is served the DEFAULT_BUCKET.
      allowedVariants: [
        'Logged-In-Booked',
        'Logged-In-Courtesy-Hold',
        'Logged-In-Non-Booked',
        'Logged-In-Recently-Searched',
      ],
    },
  ],

  /** URL segment of the variant child items; middleware appends `${path}/Page Variants/${variantId}`. */
  PAGE_VARIANTS_SEGMENT: 'Page Variants',

  /** Query param that forces a variant, mirroring the middleware's `?pv=` test mode. */
  TEST_VARIANT_QUERY_PARAM: 'pv',

  /** Locale → market mapping, mirroring src/lib/engage/getPersonalizeContext.ts. */
  DEFAULT_LOCALE: 'en',
  AU_LOCALE: 'en-AU',
  SELECTED_CURRENCY_COOKIE: 'SelectedCurrency',
  LOCALE_MARKET_MAP: {
    en: { pointOfSale: 'carnivalUS', currency: 'USD' },
    'en-US': { pointOfSale: 'carnivalUS', currency: 'USD' },
    'en-AU': { pointOfSale: 'carnivalAU', currency: 'AUD' },
    'en-NZ': { pointOfSale: 'carnivalNZ', currency: 'NZD' },
  },
  AU_CURRENCY_MARKET_MAP: {
    AUD: { pointOfSale: 'carnivalAU', currency: 'AUD' },
    NZD: { pointOfSale: 'carnivalNZ', currency: 'NZD' },
  },

  /** Sub-request timeouts (ms). Fail open to the default page on expiry. */
  BROWSER_CREATE_TIMEOUT_MS: 1000,
  CALLFLOWS_TIMEOUT_MS: 1500,

  /** bid_<clientKey> cookie lifetime; middleware initServer() uses cookieExpiryDays: 365. */
  BID_COOKIE_EXPIRY_DAYS: 365,

  /** Cookie Domain attribute (NEXT_PUBLIC_ENGAGE_COOKIE_DOMAIN, e.g. '.carnival.com'). Empty = host-only. */
  COOKIE_DOMAIN: '',

  /** Cookie read by PersonalizeGtmSync on the client (URL-encoded JSON payload). */
  GTM_COOKIE_NAME: 'sc_personalize_gtm',

  /**
   * User-defined Property Manager variable used as the extra cache-key dimension.
   * MUST be declared in the property configuration or setVariable() throws.
   */
  CACHE_KEY_VARIABLE: 'PMUSER_EW_BUCKET',

  /** Cache-key value for un-personalized traffic (no variant / errors / timeouts). */
  DEFAULT_BUCKET: 'default',

  /**
   * Internal request headers used to pass per-request state from onClientRequest
   * to onClientResponse (works on cache hits too). They are also forwarded to
   * origin: `originSkip` intentionally so, letting the origin middleware skip
   * personalization for edge-personalized requests.
   */
  HEADERS: {
    bid: 'x-ew-pz-bid',
    bidNew: 'x-ew-pz-bid-new',
    gtm: 'x-ew-pz-gtm',
    bucket: 'x-ew-pz-bucket',
    originSkip: 'x-edge-personalize',
    debug: 'x-ew-pz-debug',
  },

  /** Adds an `x-ew-pz-bucket` response header when the request carries HEADERS.debug. */
  DEBUG: true,

  /**
   * Budget guards for the `cookies_*` experience params sent to callFlows
   * (the middleware forwards every request cookie; these caps keep the
   * sub-request body bounded). Cookies above the per-value cap are skipped.
   */
  MAX_COOKIE_PARAM_VALUE_BYTES: 1024,
  MAX_COOKIE_PARAMS_TOTAL_BYTES: 8192,
};
