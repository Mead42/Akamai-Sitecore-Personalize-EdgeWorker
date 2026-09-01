// Live implementation of the Akamai 'http-request' module for the local
// simulator. Relative '/__engage/*' sub-requests are rewritten to the real
// Engage host — mirroring the Property Manager pass-through rule that strips
// the prefix and swaps the origin. options.timeout is honored like the
// EdgeWorkers runtime (expiry throws, which the worker fails open on).
const calls = [];
let engageOrigin = process.env.EW_ENGAGE_ORIGIN || 'https://api-engage-us.sitecorecloud.io';

export function __getHttpCalls() {
  return calls;
}

export function __resetHttp() {
  calls.length = 0;
}

export function __setEngageOrigin(origin) {
  engageOrigin = origin;
}

export async function httpRequest(url, options = {}) {
  const target = url.startsWith('/__engage')
    ? engageOrigin + url.slice('/__engage'.length)
    : url.startsWith('/')
      ? engageOrigin + url
      : url;
  calls.push({ url: target, method: options.method || 'GET' });
  const res = await fetch(target, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body,
    signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
  });
  return {
    status: res.status,
    getHeader: (name) => res.headers.get(name) ?? undefined,
    json: () => res.json(),
    text: () => res.text(),
  };
}
