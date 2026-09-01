// Mock EdgeWorkers request/response objects covering the API surface main.js
// uses: getHeader/setHeader/removeHeader, setVariable/cacheKey.includeVariable,
// route(), and multi-value response headers.

/**
 * @param {object} init
 * @param {string} [init.method]  default 'GET'
 * @param {string} [init.host]    default 'www.carnival.com'
 * @param {string} [init.path]    default '/'
 * @param {string} [init.query]   query string WITHOUT '?', default ''
 * @param {object} [init.headers] name -> value | value[]
 */
export function makeRequest(init = {}) {
  const headers = new Map();
  for (const [name, value] of Object.entries(init.headers || {})) {
    headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : [String(value)]);
  }
  const variables = {};
  const includedVariables = [];
  const routed = [];

  return {
    method: init.method || 'GET',
    host: init.host || 'www.carnival.com',
    path: init.path || '/',
    query: init.query || '',
    getHeader(name) {
      const values = headers.get(name.toLowerCase());
      return values && values.length > 0 ? values : undefined;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), [String(value)]);
    },
    addHeader(name, value) {
      const key = name.toLowerCase();
      headers.set(key, [...(headers.get(key) || []), String(value)]);
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    setVariable(name, value) {
      variables[name] = value;
    },
    getVariable(name) {
      return variables[name];
    },
    cacheKey: {
      includeVariable(name) {
        includedVariables.push(name);
      },
    },
    route(destination) {
      routed.push(destination);
    },
    // Test inspection points.
    __headers: headers,
    __variables: variables,
    __includedVariables: includedVariables,
    __routed: routed,
  };
}

export function makeResponse(init = {}) {
  const headers = new Map();
  return {
    status: init.status || 200,
    getHeader(name) {
      const values = headers.get(name.toLowerCase());
      return values && values.length > 0 ? values : undefined;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), [String(value)]);
    },
    addHeader(name, value) {
      const key = name.toLowerCase();
      headers.set(key, [...(headers.get(key) || []), String(value)]);
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    __headers: headers,
  };
}
