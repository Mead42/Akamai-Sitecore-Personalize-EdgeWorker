// Node module-resolution hook: the EdgeWorker imports Akamai built-in modules
// by bare specifier; outside the Akamai runtime those don't exist, so resolve
// them to the mocks in ./mocks instead. Everything else resolves normally.
// With EW_HTTP=live (the local simulator), 'http-request' resolves to a real
// fetch-backed implementation instead of the test stub.
const AKAMAI_BUILTINS = new Set(['http-request', 'cookies', 'log', 'url-search-params']);

export async function resolve(specifier, context, nextResolve) {
  if (AKAMAI_BUILTINS.has(specifier)) {
    const file =
      specifier === 'http-request' && process.env.EW_HTTP === 'live'
        ? 'http-request-live'
        : specifier;
    return {
      url: new URL(`./mocks/${file}.js`, import.meta.url).href,
      format: 'module',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
