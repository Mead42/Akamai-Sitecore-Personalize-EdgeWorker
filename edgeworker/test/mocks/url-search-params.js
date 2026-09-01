// Mock of the Akamai EdgeWorkers 'url-search-params' module. Akamai's module
// implements the WHATWG URLSearchParams API, so Node's built-in is a faithful
// stand-in ('+' decodes to space, percent-decoding, entries() in insertion order).
export default globalThis.URLSearchParams;
