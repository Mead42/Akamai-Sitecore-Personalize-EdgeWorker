// Registers the loader that maps Akamai EdgeWorkers built-in modules
// ('http-request', 'cookies', 'log', 'url-search-params') to local mocks.
// Usage: node --import ./test/register.mjs --test ./test/
import { register } from 'node:module';

register(new URL('./loader.mjs', import.meta.url));
