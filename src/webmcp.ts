import {
  executePageWebMcp,
  pageWebMcpCallRequest,
  type PageCallToolParams,
  type PageWebMcpRequest,
  type PageWebMcpResult,
} from '@mearl/browser-core';
import type { JsonObject } from '@mearl/provider';
import type { FirefoxBrowser } from './browser.js';

const SANDBOX = 'mearl-webmcp';

/** Run WebMCP in one named BiDi sandbox so tool refs survive until navigation. */
export async function evaluateFirefoxWebMcp(
  browser: FirefoxBrowser,
  context: string,
  request: PageWebMcpRequest,
  deadline?: number,
): Promise<PageWebMcpResult> {
  const expression = `(async () => JSON.stringify(await (${executePageWebMcp.toString()})(${JSON.stringify(request)})))()`;
  let value: unknown;
  try {
    value = await browser.evaluateExpression(context, expression, true, deadline, SANDBOX);
  } catch {
    throw new Error('WEBMCP_EXECUTION_UNAVAILABLE: Check page state before retrying');
  }
  if (typeof value !== 'string') throw new Error('WEBMCP_EXECUTION_UNAVAILABLE: Check page state before retrying');
  return JSON.parse(value) as PageWebMcpResult;
}

export async function callFirefoxWebMcp(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const params = data as unknown as PageCallToolParams;
  const request = pageWebMcpCallRequest(params);
  browser.webmcpFor(context).assertRef(params.toolRef);
  const reply = await evaluateFirefoxWebMcp(browser, context, request, deadline);
  if ('result' in reply) return reply;
  throw new Error('error' in reply ? reply.error : 'WEBMCP_CALL_FAILED: Unexpected browser reply');
}

export async function refreshFirefoxWebMcp(browser: FirefoxBrowser, context: string, deadline?: number) {
  const observation = browser.webmcpFor(context);
  await observation.refresh(() => evaluateFirefoxWebMcp(browser, context, { operation: 'discover' }, deadline));
  return observation;
}
