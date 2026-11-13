import { readFileSync } from 'node:fs';
import type {
  BrowserProviderDefinition,
  ProviderBrowser,
  ProviderPackageMetadata,
} from '@mearl/provider';
import { BiDiConnection, BiDiError } from './bidi.js';
import { FirefoxBrowser } from './browser.js';
import './browser-capabilities.js';
import { FIREFOX_ACTIONS } from './capabilities.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  mearl: { provider: ProviderPackageMetadata };
};
const { providerId, name, protocolVersion, browserType } = pkg.mearl.provider;
const actions = [...FIREFOX_ACTIONS];

export function createFirefoxProvider(updateBrowsers: (browsers: ProviderBrowser[]) => void) {
  const attached = new Map<string, { browser: FirefoxBrowser; info: ProviderBrowser }>();
  const busy = new Set<string>();
  const listBrowsers = () => [...attached.values()].map(item => item.info);
  let nextTabId = 0;
  let stopping = false;

  const definition: BrowserProviderDefinition = {
    descriptor: { providerId, name, version: pkg.version, protocolVersion },
    browserType,
    listBrowsers,
    async launch({ port }, { deadline }) {
      if (stopping) throw new Error('Firefox Provider is stopping');
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('providerOptions.port must be an integer from 1 to 65535');
      const browserId = String(port);
      const existing = attached.get(browserId);
      if (busy.has(browserId)) throw new Error(`Firefox port ${port} is being attached or detached`);
      if (existing?.browser.connection.connected) return existing.info;
      busy.add(browserId);
      let connection: BiDiConnection | undefined;
      let createdSession = false;
      try {
        connection = await BiDiConnection.connect(port, deadline);
        const { capabilities } = await connection.send<{ capabilities: { browserName: string } }>(
          'session.new',
          { capabilities: { alwaysMatch: { browserName: 'firefox', unhandledPromptBehavior: { default: 'ignore' } } } },
          deadline,
        );
        createdSession = true;
        if (capabilities.browserName !== 'firefox') throw new Error('The BiDi endpoint is not Firefox');
        if (stopping || !connection.connected) throw new Error('Firefox attachment was interrupted');
        const info: ProviderBrowser = {
          browserId,
          name: `Firefox (${port})`,
          status: 'connected',
          control: { kind: 'provider', capabilities: { actions, screenshot: 'native', nativeDialogs: true } },
          ownership: 'attached',
          persistence: 'persistent',
          operations: ['detach'],
        };
        const browser = new FirefoxBrowser(connection, () => ++nextTabId);
        await browser.arm(deadline);
        if (stopping || !connection.connected) throw new Error('Firefox attachment was interrupted');
        connection.onClose(() => {
          if (attached.get(browserId)?.browser !== browser) return;
          attached.delete(browserId);
          if (!stopping) updateBrowsers(listBrowsers());
        });
        attached.set(browserId, { browser, info });
        updateBrowsers(listBrowsers());
        return info;
      } catch (error) {
        if (createdSession) await connection?.end().catch(() => {});
        else connection?.disconnect();
        if (error instanceof BiDiError && error.code === 'session not created' &&
            error.message.includes('Maximum number of active sessions')) {
          throw new Error(`Firefox port ${port} already has a BiDi session. End it before attaching Mearl.`, { cause: error });
        }
        throw error;
      } finally {
        busy.delete(browserId);
      }
    },
    async close() {
      throw new Error('Firefox is owned by the user. Use browser_manage detach to disconnect.');
    },
    async detach({ browserId }) {
      const current = attached.get(browserId);
      if (!current) throw new Error(`Firefox browser not attached: ${browserId}`);
      if (busy.has(browserId)) throw new Error(`Firefox port ${browserId} is already being detached`);
      busy.add(browserId);
      try {
        await current.browser.connection.end();
        return { detached: true };
      } finally {
        busy.delete(browserId);
        if (attached.delete(browserId)) updateBrowsers(listBrowsers());
      }
    },
    async handleAction(request) {
      const current = attached.get(request.browserId);
      if (!current || busy.has(request.browserId)) throw new Error('Firefox browser is not attached');
      return current.browser.act(request);
    },
  };

  return {
    definition,
    async stop() {
      stopping = true;
      const browsers = [...attached.values()];
      attached.clear();
      await Promise.all(browsers.map(({ browser }) => browser.connection.end().catch(() => {})));
    },
  };
}
