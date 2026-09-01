// Mock of the Akamai EdgeWorkers 'http-request' module. Tests install a
// handler with __setHttpHandler(); every httpRequest() call is recorded and
// answered by that handler. A handler that throws simulates a network error
// or timeout.
let handler = null;
const calls = [];

export function __setHttpHandler(fn) {
  handler = fn;
}

export function __getHttpCalls() {
  return calls;
}

export function __resetHttp() {
  handler = null;
  calls.length = 0;
}

export async function httpRequest(url, options = {}) {
  calls.push({ url, options });
  if (!handler) throw new Error(`unexpected sub-request (no handler installed): ${url}`);
  const result = await handler(url, options);
  return {
    status: result.status,
    getHeader: (name) => (result.headers ? result.headers[name.toLowerCase()] : undefined),
    async json() {
      if (!('json' in result)) throw new Error('mock response has no json body');
      return typeof result.json === 'function' ? result.json() : result.json;
    },
    async text() {
      return JSON.stringify(result.json ?? null);
    },
  };
}
