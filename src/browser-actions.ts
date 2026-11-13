import {
  filterCookiesForUrl,
  resolveEmulationConfig,
  resolveGetCookieTarget,
  resolveSetCookieTarget,
  runActionBatch,
  selectReadableCookie,
  type GetCookieParams,
  type RunActionsParams,
  type SendRequestParams,
  type SetCookieParams,
  type SetDeviceEmulationParams,
  type SetRuleParams,
  type SetTimezoneParams,
} from '@mearl/browser-core';
import type { JsonObject, ProviderAction, ProviderActionContext } from '@mearl/provider';
import type { FirefoxBrowser } from './browser.js';
import { describeFirefoxCapabilities } from './capture.js';
import { sendFirefoxRequest } from './request.js';
import { bytesValue } from './values.js';

async function currentUrl(browser: FirefoxBrowser, data: { tabId?: number; url?: string }, deadline?: number): Promise<string | undefined> {
  if (typeof data.url === 'string' && data.url.trim()) return undefined;
  if (typeof data.tabId !== 'number') return undefined;
  return (await browser.pageInfo(browser.contextFor(data.tabId), deadline)).url;
}

export async function getFirefoxCookie(browser: FirefoxBrowser, data: JsonObject, deadline?: number) {
  const input = data as unknown as GetCookieParams;
  const pageUrl = await currentUrl(browser, input, deadline);
  const target = resolveGetCookieTarget(pageUrl, input);
  const result = await browser.connection.send<{ cookies?: Array<{ name: string; value: unknown; domain: string; path: string }> }>(
    'storage.getCookies',
    { filter: { name: target.cookieName } },
    deadline,
  );
  const cookie = selectReadableCookie(
    filterCookiesForUrl(
      (result.cookies ?? []).map(item => ({ name: item.name, value: bytesValue(item.value), domain: item.domain, path: item.path })),
      target.cookieUrl,
    ),
    target,
  );
  return {
    ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
    url: input.url ? target.cookieUrl : pageUrl ?? target.cookieUrl,
    name: target.cookieName,
    found: Boolean(cookie),
    ...(cookie ? { value: cookie.value, domain: cookie.domain, path: cookie.path } : {}),
  };
}

export async function setFirefoxCookie(browser: FirefoxBrowser, data: JsonObject, deadline?: number) {
  const input = data as unknown as SetCookieParams;
  const pageUrl = await currentUrl(browser, input, deadline);
  const target = resolveSetCookieTarget(pageUrl, input);
  await browser.connection.send('storage.setCookie', {
    cookie: {
      name: target.cookieName,
      value: { type: 'string', value: target.cookieValue },
      domain: target.cookieDomain ?? target.domain,
      path: target.path,
      secure: target.cookieUrl.startsWith('https:'),
    },
  }, deadline);
  if (target.reload) {
    await browser.connection.send('browsingContext.reload', { context: browser.contextFor(input.tabId!), wait: 'interactive' }, deadline);
  }
  return {
    ...(typeof input.tabId === 'number' ? { tabId: input.tabId } : {}),
    url: input.url ? target.cookieUrl : pageUrl ?? target.cookieUrl,
    name: target.cookieName,
    domain: target.domain,
    path: target.path,
    reloaded: target.reload,
  };
}

export async function setFirefoxTimezone(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const { timezone } = data as unknown as SetTimezoneParams;
  if (typeof timezone !== 'string') throw new Error('set_timezone: "timezone" is required (IANA timezone or empty string to clear)');
  const value = timezone.trim();
  await browser.connection.send('emulation.setTimezoneOverride', { timezone: value || null, contexts: [context] }, deadline);
  return { enabled: value.length > 0, timezone: value || null };
}

export async function setFirefoxEmulation(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = data as unknown as SetDeviceEmulationParams;
  if (typeof input?.enabled !== 'boolean') throw new Error('set_device_emulation: "enabled" is required (true to enable, false to clear)');
  if (input.deviceShell === true || input.splitScreen === true) {
    throw new Error('Firefox set_device_emulation does not support deviceShell or splitScreen');
  }
  if (!input.enabled) {
    browser.touch.delete(context);
    await browser.connection.send('browsingContext.setViewport', { context, viewport: null, devicePixelRatio: null }, deadline);
    await browser.connection.send('emulation.setUserAgentOverride', { userAgent: null, contexts: [context] }, deadline).catch(() => {});
    return { enabled: false, deviceShell: false, splitScreen: false, reloaded: false };
  }
  const config = resolveEmulationConfig(input);
  await browser.connection.send('browsingContext.setViewport', {
    context,
    viewport: { width: config.width, height: config.height },
    devicePixelRatio: config.deviceScaleFactor,
  }, deadline);
  await browser.connection.send('emulation.setUserAgentOverride', { userAgent: config.userAgent, contexts: [context] }, deadline);
  await browser.connection.send('emulation.setScreenOrientationOverride', {
    screenOrientation: {
      natural: 'portrait',
      type: config.orientation === 'landscape' ? 'landscape-primary' : 'portrait-primary',
    },
    contexts: [context],
  }, deadline).catch(() => {});
  if (config.touch) browser.touch.add(context);
  else browser.touch.delete(context);
  let reloaded = false;
  if (input.reload !== false) {
    browser.clearRefs(context);
    await browser.connection.send('browsingContext.reload', { context, wait: 'interactive' }, deadline);
    reloaded = true;
  }
  return {
    enabled: true,
    preset: config.presetName,
    viewport: { width: config.width, height: config.height, deviceScaleFactor: config.deviceScaleFactor, scale: config.scale ?? 1 },
    userAgent: config.userAgent,
    mobile: config.mobile,
    touch: config.touch,
    orientation: config.orientation,
    deviceShell: false,
    splitScreen: false,
    reloaded,
  };
}

export async function dispatchBrowserAction(browser: FirefoxBrowser, request: ProviderActionContext): Promise<unknown | undefined> {
  const { action, data, deadline } = request;
  if (action === 'get_capabilities') return describeFirefoxCapabilities(data);
  if (action === 'get_cookie') return getFirefoxCookie(browser, data, deadline);
  if (action === 'set_cookie') return setFirefoxCookie(browser, data, deadline);
  if (action === 'send_request') return sendFirefoxRequest(browser.connection, data as unknown as SendRequestParams, deadline);
  if (action === 'set_rule') return browser.observation.setRule(data as unknown as SetRuleParams, deadline);
  if (action === 'get_rules') return browser.observation.getRules();
  if (action === 'run_actions') {
    return runActionBatch(data as unknown as RunActionsParams, async (name, payload) => ({
      success: true,
      data: await browser.act({ ...request, action: name as ProviderAction, data: payload }),
    }));
  }
  return undefined;
}
