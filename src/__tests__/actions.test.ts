import type { AddressInfo } from 'node:net';
import { createProviderRuntime, type ProviderBrowser } from '@mearl/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { FIREFOX_ACTIONS, FIREFOX_LIMITATIONS } from '../capabilities.js';
import { createFirefoxProvider } from '../provider.js';

const UNSUPPORTED = [
  'set_app_profile',
  'tab_group',
  'page_runtime',
  'request_permission',
  'page_download',
  'page_record',
] as const;

const SNAPSHOT_TREE = {
  role: 'RootWebArea',
  name: 'Example',
  selector: '',
  children: [{ role: 'button', name: 'Save', selector: 'button.save', inViewport: true }],
};

interface Command {
  method: string;
  params: Record<string, unknown>;
}

describe('Firefox actions', () => {
  let listener: WebSocketServer;
  let port: number;
  let socket: WebSocket | undefined;
  let commands: Command[];
  let provider: ReturnType<typeof createFirefoxProvider>;
  let runtime: ReturnType<typeof createProviderRuntime>;
  let navigateOnClick: boolean;

  beforeEach(async () => {
    socket = undefined;
    commands = [];
    navigateOnClick = false;
    listener = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/session' });
    await new Promise<void>(resolve => listener.once('listening', resolve));
    port = (listener.address() as AddressInfo).port;
    listener.on('connection', client => {
      socket = client;
      client.on('message', raw => {
        const message = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown> };
        const params = message.params ?? {};
        commands.push({ method: message.method, params });
        const result = reply(message.method, params);
        if (navigateOnClick && message.method === 'input.performActions') {
          client.send(JSON.stringify({
            type: 'event',
            method: 'browsingContext.navigationStarted',
            params: { context: 'existing' },
          }));
        }
        if (result) client.send(JSON.stringify({ id: message.id, type: 'success', result }));
        else client.send(JSON.stringify({ id: message.id, type: 'error', error: 'unknown command', message: message.method }));
      });
    });
    provider = createFirefoxProvider(() => {});
    runtime = createProviderRuntime(provider.definition);
  });

  afterEach(async () => {
    await provider.stop();
    for (const client of listener.clients) client.terminate();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  });

  function emit(method: string, params: object): void {
    socket?.send(JSON.stringify({ type: 'event', method, params }));
  }

  async function attach(): Promise<ProviderBrowser> {
    return runtime.launch({ port });
  }

  async function tabId(): Promise<number> {
    const listed = await runtime.invokeAction({ browserId: String(port), action: 'tab_list', data: {} }) as {
      tabs: Array<{ tabId: number }>;
    };
    return listed.tabs[0]!.tabId;
  }

  function invoke(action: string, data: Record<string, unknown>) {
    return runtime.invokeAction({ browserId: String(port), action: action as never, data });
  }

  it('advertises the implemented CDP action set and refuses extension-only actions', async () => {
    const browser = await attach();
    expect(browser.control).toMatchObject({
      kind: 'provider',
      capabilities: { actions: [...FIREFOX_ACTIONS], screenshot: 'native', nativeDialogs: true },
    });
    const catalog = await invoke('get_capabilities', {}) as { actions: string[]; devicePresets: string[]; apps: { status: string }; limitations: string[] };
    expect(catalog.actions).toEqual([...FIREFOX_ACTIONS]);
    expect(catalog.devicePresets.length).toBeGreaterThan(0);
    expect(catalog.apps.status).toBe('unsupported');
    expect(catalog.limitations).toEqual(expect.arrayContaining([...FIREFOX_LIMITATIONS]));
    for (const action of UNSUPPORTED) {
      expect(catalog.actions).not.toContain(action);
      await expect(invoke(action, {})).rejects.toThrow(`does not support ${action}`);
    }
    const id = await tabId();
    await expect(invoke('set_device_emulation', { tabId: id, enabled: true, deviceShell: true }))
      .rejects.toThrow('does not support deviceShell');
    await expect(invoke('page_eval', { tabId: id, expression: '1', executionWorld: 'isolated' }))
      .rejects.toThrow('Invalid user script worldId');
  });

  it('evaluates a page, assigns snapshot refs, and clicks one with trusted mouse input', async () => {
    await attach();
    const id = await tabId();
    await expect(invoke('page_eval', { tabId: id, expression: '6 * 7' })).resolves.toEqual({ result: 42 });
    const snapshot = await invoke('page_snapshot', { tabId: id }) as { snapshot: string; elementCount: number };
    expect(snapshot.elementCount).toBe(2);
    expect(snapshot.snapshot).toContain('@e1 [button "Save"]');
    const clicked = await invoke('page_click', { tabId: id, selector: '@e1', clickMode: 'mouse' });
    expect(clicked).toMatchObject({
      clicked: true,
      dispatchMode: 'trusted-input',
      pointerType: 'mouse',
      requestedTarget: { kind: 'ref', selector: '@e1', role: 'button', name: 'Save' },
    });
    navigateOnClick = true;
    await expect(invoke('page_click', { tabId: id, selector: '@e1', clickMode: 'mouse' }))
      .resolves.toMatchObject({ clicked: true, dispatchMode: 'trusted-input' });
    expect(commands.find(command => command.method === 'browsingContext.locateNodes')?.params).toMatchObject({
      context: 'existing',
      locator: { type: 'css', value: 'button.save' },
    });
    expect(commands.find(command => command.method === 'input.performActions')?.params).toMatchObject({
      context: 'existing',
      actions: [{
        type: 'pointer',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: 'viewport', x: 12, y: 34 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
  });

  it('sets a timezone and runs a page action batch', async () => {
    await attach();
    const id = await tabId();
    await expect(invoke('set_timezone', { tabId: id, timezone: 'Asia/Shanghai' })).resolves.toEqual({
      enabled: true,
      timezone: 'Asia/Shanghai',
    });
    expect(commands.at(-1)).toMatchObject({
      method: 'emulation.setTimezoneOverride',
      params: { timezone: 'Asia/Shanghai', contexts: ['existing'] },
    });
    const batch = await invoke('run_actions', {
      tabId: id,
      actions: [{ action: 'page_eval', data: { expression: '6 * 7' } }],
    }) as { completedSteps: number; results: Array<{ success: boolean; data: { result: number } }> };
    expect(batch.completedSteps).toBe(1);
    expect(batch.results[0]).toMatchObject({ success: true, action: 'page_eval', data: { result: 42 } });
    await expect(invoke('run_actions', {
      tabId: id,
      actions: [{ action: 'get_capabilities', data: {} }],
    })).resolves.toMatchObject({ completedSteps: 0, failedStep: 0, error: expect.stringContaining('get_capabilities') });
  });

  it('reads a native prompt and accepts it through page_press', async () => {
    await attach();
    const id = await tabId();
    emit('browsingContext.userPromptOpened', {
      context: 'existing',
      type: 'prompt',
      message: 'Name?',
      defaultValue: 'Ada',
    });
    const snapshot = await vi.waitFor(async () => {
      const value = await invoke('page_snapshot', { tabId: id }) as { dialog?: { id: string; type: string; defaultPrompt?: string }; url?: string };
      expect(value.dialog?.id).toEqual(expect.any(String));
      return value;
    });
    expect(snapshot).toMatchObject({
      snapshot: '[native prompt dialog]',
      url: 'https://example.com/',
      title: 'Example',
      dialog: { type: 'prompt', message: 'Name?', defaultPrompt: 'Ada' },
    });
    await expect(invoke('page_press', { tabId: id, dialogId: snapshot.dialog!.id, key: 'Enter', promptText: 'Lin' }))
      .resolves.toEqual({ pressed: true, key: 'Enter', dispatchMode: 'native-dialog' });
    expect(commands.at(-1)).toMatchObject({
      method: 'browsingContext.handleUserPrompt',
      params: { context: 'existing', accept: true, userText: 'Lin' },
    });
    emit('browsingContext.userPromptOpened', {
      context: 'existing',
      type: 'alert',
      message: 'Wait',
    });
    const alert = await vi.waitFor(async () => {
      const value = await invoke('page_snapshot', { tabId: id }) as { dialog?: { id: string; type?: string } };
      expect(value.dialog?.type).toBe('alert');
      return value;
    });
    emit('browsingContext.navigationStarted', { context: 'existing' });
    await vi.waitFor(async () => {
      const value = await invoke('page_snapshot', { tabId: id }) as { dialog?: { id: string } };
      expect(value.dialog).toBeUndefined();
    });
    await expect(invoke('page_press', { tabId: id, dialogId: alert.dialog!.id, key: 'Enter' }))
      .rejects.toThrow('dialogId is stale');
  });

  it('captures a console log and fulfills a blocked request from set_mock', async () => {
    await attach();
    const id = await tabId();
    emit('log.entryAdded', {
      source: { context: 'existing' },
      level: 'info',
      text: 'hello firefox',
      type: 'console',
      timestamp: 1,
    });
    await vi.waitFor(async () => {
      const logs = await invoke('get_logs', { tabId: id, filter: 'hello firefox' }) as { meta: { source: string; count: number }; logs: Array<{ message: string }> };
      expect(logs.meta).toMatchObject({ source: 'bidi', count: 1 });
      expect(logs.logs[0]?.message).toBe('hello firefox');
    });
    await expect(invoke('set_mock', { tabId: id, apiName: 'orders', mockData: { ok: true } })).resolves.toMatchObject({
      success: true,
      message: 'Mock set for orders',
    });
    expect(commands.some(command => command.method === 'network.addIntercept' && JSON.stringify(command.params.phases) === JSON.stringify(['beforeRequestSent']))).toBe(true);
    emit('network.beforeRequestSent', {
      context: 'existing',
      isBlocked: true,
      request: { request: 'req-1', url: 'https://example.com/api/orders', method: 'GET', headers: [] },
    });
    await vi.waitFor(() => {
      const provided = commands.find(command => command.method === 'network.provideResponse');
      expect(provided?.params).toMatchObject({
        request: 'req-1',
        statusCode: 200,
        body: { type: 'string', value: '{"ok":true}' },
      });
    });
  });

  it('evaluates in an isolated sandbox, captures the document, and reads WebMCP from the snapshot', async () => {
    await attach();
    const id = await tabId();
    await expect(invoke('page_eval', { tabId: id, expression: '6 * 7', executionWorld: 'isolated', worldId: 'tools' }))
      .resolves.toEqual({ result: 42 });
    expect(commands.find(command => command.method === 'script.evaluate' && command.params.expression === '6 * 7')?.params.target)
      .toMatchObject({ context: 'existing', sandbox: 'mearl-tools' });
    await invoke('page_screenshot', { tabId: id, captureMode: 'cdp' });
    expect(commands.find(command => command.method === 'browsingContext.captureScreenshot')?.params).toMatchObject({
      context: 'existing',
      origin: 'document',
    });
    const snapshot = await invoke('page_snapshot', { tabId: id, includeWebMcp: 'full' }) as { webmcp?: Array<{ ref: string; name: string }> };
    expect(snapshot.webmcp?.[0]).toMatchObject({ name: 'get_order' });
    await expect(invoke('page_call_tool', { tabId: id, toolRef: snapshot.webmcp![0]!.ref, arguments: {} }))
      .resolves.toEqual({ result: { ok: true } });
  });

  it('rewrites a blocked request from set_rule and parses tracking events', async () => {
    await attach();
    const id = await tabId();
    await expect(invoke('set_rule', {
      actionType: 'modifyHeaders',
      filter: 'example\\.com',
      requestHeaders: [{ header: 'X-Test', operation: 'set', value: '1' }],
    })).resolves.toMatchObject({ success: true, ruleId: 1 });
    await expect(invoke('get_rules', {})).resolves.toMatchObject({
      enabled: true,
      rules: [expect.objectContaining({ ruleId: 1, filter: 'example\\.com' })],
    });
    emit('network.beforeRequestSent', {
      context: 'existing',
      isBlocked: true,
      request: {
        request: 'req-rule',
        url: 'https://example.com/api/orders',
        method: 'GET',
        headers: [{ name: 'Accept', value: { type: 'string', value: 'application/json' } }],
      },
    });
    await vi.waitFor(() => {
      const continued = commands.find(command => command.method === 'network.continueRequest' && command.params.request === 'req-rule');
      expect(continued?.params.headers).toEqual(expect.arrayContaining([
        { name: 'X-Test', value: { type: 'string', value: '1' } },
      ]));
    });
    emit('network.beforeRequestSent', {
      context: 'existing',
      isBlocked: false,
      request: { request: 'req-track', url: 'https://log.mmstat.com/v.gif?gmkey=CLK&gokey=spm%3Da.b', method: 'GET', headers: [] },
    });
    await vi.waitFor(async () => {
      const events = await invoke('get_events', { tabId: id, source: 'aplus' }) as { meta: { captureSource: string; count: number }; events: Array<{ source: string; name: string }> };
      expect(events.meta).toMatchObject({ captureSource: 'bidi', count: 1 });
      expect(events.events[0]).toMatchObject({ source: 'aplus', name: 'a.b' });
    });
  });
});

function reply(method: string, params: Record<string, unknown>): object | undefined {
  switch (method) {
    case 'session.new':
      return { capabilities: { browserName: 'firefox' } };
    case 'session.end':
    case 'session.subscribe':
    case 'input.performActions':
    case 'input.releaseActions':
    case 'browsingContext.handleUserPrompt':
    case 'emulation.setTimezoneOverride':
    case 'network.continueRequest':
    case 'network.provideResponse':
    case 'browsingContext.captureScreenshot':
      return method === 'browsingContext.captureScreenshot' ? { data: 'aW1hZ2U=' } : {};
    case 'network.addDataCollector':
      return { collector: 'collector' };
    case 'network.addIntercept':
      return { intercept: 'intercept-1' };
    case 'browsingContext.getTree':
      return { contexts: [{ context: 'existing', url: 'https://example.com/' }] };
    case 'browsingContext.locateNodes':
      return { nodes: [{ sharedId: 'node-1' }] };
    case 'script.evaluate': {
      const expression = String(params.expression ?? '');
      if (expression.includes('executePageWebMcp')) {
        const payload = expression.includes('"operation":"discover"')
          ? { catalog: { url: 'https://example.com/', status: 'ready', tools: [{ ref: 'webmcp:00000000-0000-4000-8000-000000000001', name: 'get_order', description: 'Read', origin: 'https://example.com' }], truncated: false } }
          : { result: { ok: true } };
        return { type: 'success', result: { type: 'string', value: JSON.stringify(payload) } };
      }
      return expression === 'document.visibilityState'
        ? { type: 'success', result: { type: 'string', value: 'visible' } }
        : { type: 'success', result: { type: 'number', value: 42 } };
    }
    case 'script.callFunction':
      return { type: 'success', result: { value: scriptValue(String(params.functionDeclaration ?? '')) } };
    default:
      return undefined;
  }
}

function scriptValue(declaration: string): string {
  if (declaration.includes('collectPageSnapshot')) return JSON.stringify({ tree: SNAPSHOT_TREE });
  if (declaration.includes('scrollIntoView') || declaration.includes('getClickCoordsFromNode')) {
    return JSON.stringify({ x: 12, y: 34, tag: 'button', text: 'Save' });
  }
  if (declaration.includes('function pageInfo')) {
    return JSON.stringify({ url: 'https://example.com/', title: 'Example', active: true });
  }
  return 'null';
}
