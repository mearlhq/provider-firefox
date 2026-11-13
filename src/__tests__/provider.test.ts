import type { AddressInfo } from 'node:net';
import { createProviderRuntime, type ProviderBrowser } from '@mearl/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createFirefoxProvider } from '../provider.js';

describe('Firefox Provider', () => {
  let listener: WebSocketServer;
  let port: number;
  let active: WebSocket | undefined;
  let calls: string[];
  let provider: ReturnType<typeof createFirefoxProvider>;
  let runtime: ReturnType<typeof createProviderRuntime>;
  let snapshots: ProviderBrowser[][];

  beforeEach(async () => {
    active = undefined;
    calls = [];
    snapshots = [];
    listener = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/session' });
    await new Promise<void>(resolve => listener.once('listening', resolve));
    port = (listener.address() as AddressInfo).port;
    listener.on('connection', socket => {
      socket.on('message', raw => {
        const { id, method } = JSON.parse(raw.toString()) as { id: number; method: string };
        calls.push(method);
        const reply = (result: object) => socket.send(JSON.stringify({ id, type: 'success', result }));
        switch (method) {
          case 'session.new':
            if (active) {
              socket.send(JSON.stringify({
                id, type: 'error', error: 'session not created', message: 'Maximum number of active sessions',
              }));
            } else {
              active = socket;
              reply({ capabilities: { browserName: 'firefox' } });
            }
            break;
          case 'session.end':
            if (active === socket) active = undefined;
            reply({});
            break;
          case 'browsingContext.getTree':
            reply({ contexts: [{ context: 'existing', url: 'https://example.com/' }] });
            break;
          case 'session.subscribe':
            reply({});
            break;
          case 'network.addDataCollector':
            reply({ collector: 'collector' });
            break;
          case 'script.callFunction':
            reply({ type: 'success', result: { value: JSON.stringify({
              url: 'https://example.com/', title: 'Example', active: true,
            }) } });
            break;
          case 'browsingContext.close':
            // The last tab remains open.
            reply({});
            break;
          default:
            throw new Error(`Unexpected BiDi command: ${method}`);
        }
      });
    });
    provider = createFirefoxProvider(browsers => {
      snapshots.push(browsers);
      runtime.updateBrowsers(browsers);
    });
    runtime = createProviderRuntime(provider.definition);
  });

  afterEach(async () => {
    await provider.stop();
    for (const socket of listener.clients) socket.terminate();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  });

  it('attaches once, refuses browser close, and ends only its BiDi session on detach', async () => {
    const browser = await runtime.launch({ port });
    expect(browser).toMatchObject({ ownership: 'attached', operations: ['detach'] });
    expect(await runtime.launch({ port })).toEqual(browser);
    expect(await runtime.listBrowsers()).toEqual([browser]);
    expect(snapshots).toEqual([[browser]]);
    await expect(runtime.close({ browserId: browser.browserId })).rejects.toThrow('does not support close');
    await expect(runtime.detach({ browserId: browser.browserId })).resolves.toEqual({ detached: true });
    expect(snapshots).toEqual([[browser], []]);
    expect(await runtime.listBrowsers()).toEqual([]);
    expect(calls).toEqual(['session.new', 'session.subscribe', 'network.addDataCollector', 'session.end']);
  });

  it('leaves another BiDi client in control when Firefox rejects the attach', async () => {
    const other = createFirefoxProvider(() => {});
    try {
      await createProviderRuntime(other.definition).launch({ port });
      await expect(runtime.launch({ port })).rejects.toThrow('already has a BiDi session');
      expect(await runtime.listBrowsers()).toEqual([]);
      expect(snapshots).toEqual([]);
      expect(calls).toEqual(['session.new', 'session.subscribe', 'network.addDataCollector', 'session.new']);
      expect(active).toBeDefined();
    } finally {
      await other.stop();
    }
  });

  it('removes a disconnected Firefox from the published list', async () => {
    const browser = await runtime.launch({ port });
    active?.terminate();
    await vi.waitFor(() => expect(snapshots).toEqual([[browser], []]));
    expect(await runtime.listBrowsers()).toEqual([]);
  });

  it('keeps a stable ID for a tab when Firefox declines to close its last tab', async () => {
    const { browserId } = await runtime.launch({ port });
    const list = () => runtime.invokeAction({ browserId, action: 'tab_list', data: {} });
    const first = (await list()) as { tabs: { tabId: number }[] };
    const { tabId } = first.tabs[0];
    await expect(runtime.invokeAction({ browserId, action: 'tab_close', data: { tabId } }))
      .rejects.toThrow('Firefox kept the tab open');
    expect(await list()).toEqual(first);
  });
});
