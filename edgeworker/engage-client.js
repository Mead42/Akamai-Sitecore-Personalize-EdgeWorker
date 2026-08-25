/**
 * Minimal Sitecore Personalize (Engage / CDP) client for Akamai EdgeWorkers.
 *
 * Reproduces the two HTTP calls made by @sitecore/engage on the server:
 *  - GET  {targetURL}/v1.2/browser/create.json?client_key=...&message={}   -> { ref }
 *  - POST {targetURL}/v2/callFlows                                         -> flow execution result
 *
 * Both calls fail soft (return undefined/null) so the page is always served.
 */
import { httpRequest } from 'http-request';
import { logger } from 'log';
import CONFIG from './config.js';

function engageUrl(pathAndQuery) {
  const base = CONFIG.ENGAGE_API_BASE.endsWith('/')
    ? CONFIG.ENGAGE_API_BASE.slice(0, -1)
    : CONFIG.ENGAGE_API_BASE;
  return base + pathAndQuery;
}

/**
 * Creates a new CDP browser reference (the value of the bid_<clientKey> cookie).
 * Mirrors @sitecore/engage getBrowserIdFromCdp().
 * @returns {Promise<string|undefined>} the browser ref, or undefined on failure
 */
export async function createBrowserRef() {
  try {
    const url = engageUrl(
      `/v1.2/browser/create.json?client_key=${encodeURIComponent(CONFIG.CLIENT_KEY)}&message=%7B%7D`
    );
    const res = await httpRequest(url, {
      method: 'GET',
      headers: { 'X-Library-Version': CONFIG.LIBRARY_VERSION },
      timeout: CONFIG.BROWSER_CREATE_TIMEOUT_MS,
    });
    if (res.status !== 200) {
      logger.error(`pz: browser/create returned ${res.status}`);
      return undefined;
    }
    const data = await res.json();
    return data && typeof data.ref === 'string' && data.ref.length > 0 ? data.ref : undefined;
  } catch (err) {
    logger.error(`pz: browser/create failed: ${err.message}`);
    return undefined;
  }
}

/**
 * Executes an interactive full-stack experience via /v2/callFlows.
 * Body shape mirrors @sitecore/engage Personalizer.mapPersonalizeInputToCDPData():
 * { channel, clientKey, currencyCode, friendlyId, language, params, pointOfSale, browserId }
 * @param {object} body the callFlows request body
 * @returns {Promise<object|null>} parsed flow result, or null on failure
 */
export async function executeFlow(body) {
  try {
    const res = await httpRequest(engageUrl('/v2/callFlows'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Library-Version': CONFIG.LIBRARY_VERSION,
      },
      body: JSON.stringify(body),
      timeout: CONFIG.CALLFLOWS_TIMEOUT_MS,
    });
    if (res.status !== 200) {
      logger.error(`pz: callFlows returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.error(`pz: callFlows failed: ${err.message}`);
    return null;
  }
}
