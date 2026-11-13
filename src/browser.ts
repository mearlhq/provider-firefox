import {
  PageDialogState,
  PageWebMcpObservation,
  selectMatchingTab,
  validateRequiredActionTabId,
  type TabOpenParams,
} from '@mearl/browser-core';
import type { JsonObject, ProviderActionContext } from '@mearl/provider';
import { BiDiConnection, BiDiError } from './bidi.js';
import { dispatchBrowserAction } from './browser-actions.js';
import { FirefoxObservation } from './capture.js';
import {
  clickFirefoxPage,
  dragFirefoxPage,
  evalFirefoxPage,
  framesFirefoxPage,
  hoverFirefoxPage,
  inspectFirefoxPage,
  navigateFirefoxPage,
  pressFirefoxPage,
  screenshotFirefoxPage,
  scrollFirefoxPage,
  snapshotFirefoxPage,
  typeFirefoxPage,
  uploadFirefoxPage,
  waitFirefoxPage,
} from './page-actions.js';
import { setFirefoxEmulation, setFirefoxTimezone } from './browser-actions.js';
import { fromRemoteValue, toLocalValue } from './values.js';
import { callFirefoxWebMcp } from './webmcp.js';

interface BrowsingContext {
  context: string;
  url: string;
}

export interface FirefoxRef {
  selector: string;
  role: string;
  name: string;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function rejectOptions(data: JsonObject, options: string[]): void {
  for (const option of options) {
    if (data[option] !== undefined && data[option] !== false) {
      throw new Error(`Firefox Provider does not support ${option} for this action`);
    }
  }
}

export class FirefoxBrowser {
  private readonly contexts = new Map<string, number>();
  private readonly tabs = new Map<number, string>();
  private readonly refs = new Map<string, Map<string, FirefoxRef>>();
  private readonly dialogs = new Map<string, PageDialogState>();
  private readonly webmcp = new Map<string, PageWebMcpObservation>();
  readonly touch = new Set<string>();
  readonly observation: FirefoxObservation;

  constructor(
    readonly connection: BiDiConnection,
    private readonly allocateTabId: () => number,
  ) {
    this.observation = new FirefoxObservation(this);
  }

  arm(deadline?: number): Promise<void> {
    return this.observation.arm(deadline);
  }

  contextFor(tabId: number): string {
    const context = this.tabs.get(tabId);
    if (!context) throw new Error(`Firefox tab not found: ${tabId}`);
    return context;
  }

  tabIdFor(context: string): number {
    const known = this.contexts.get(context);
    if (known !== undefined) return known;
    const tabId = this.allocateTabId();
    this.contexts.set(context, tabId);
    this.tabs.set(tabId, context);
    return tabId;
  }

  forgetContext(context: string): void {
    const tabId = this.contexts.get(context);
    if (tabId !== undefined) this.tabs.delete(tabId);
    this.contexts.delete(context);
    this.refs.delete(context);
    this.dialogs.delete(context);
    this.webmcp.delete(context);
    this.touch.delete(context);
  }

  webmcpFor(context: string): PageWebMcpObservation {
    let observation = this.webmcp.get(context);
    if (!observation) {
      observation = new PageWebMcpObservation();
      this.webmcp.set(context, observation);
    }
    return observation;
  }

  resetWebMcp(context: string): void {
    this.webmcp.get(context)?.reset();
  }

  dialogsFor(context: string): PageDialogState {
    let dialogs = this.dialogs.get(context);
    if (!dialogs) {
      dialogs = new PageDialogState();
      this.dialogs.set(context, dialogs);
    }
    return dialogs;
  }

  clearRefs(context: string): void {
    this.refs.delete(context);
  }

  replaceRefs(context: string, refs: Map<string, FirefoxRef>): void {
    this.refs.set(context, refs);
  }

  refFor(context: string, selector: string): FirefoxRef | undefined {
    if (!selector.startsWith('@e')) return undefined;
    const ref = this.refs.get(context)?.get(selector);
    if (!ref) throw new Error(`Ref ${selector} not found. Run page_snapshot first to get fresh refs.`);
    return ref;
  }

  resolveSelector(context: string, selector: string): string {
    return this.refFor(context, selector)?.selector ?? selector;
  }

  async callInPage<T>(
    context: string,
    fn: Function | string,
    args: unknown[],
    deadline?: number,
    target?: { sharedId: string },
  ): Promise<T> {
    const inner = typeof fn === 'string' ? fn : fn.toString();
    const response = await this.connection.send<{
      type?: string;
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>('script.callFunction', {
      target: { context },
      functionDeclaration: `function(...args){const fn=(${inner});const value=fn.apply(this,args);return JSON.stringify(value===undefined?null:value);}`,
      arguments: args.map(item => toLocalValue(item)),
      ...(target ? { this: target } : {}),
      awaitPromise: false,
    }, deadline);
    if (response.type === 'exception') throw new Error(response.exceptionDetails?.text || 'Firefox script failed');
    if (typeof response.result?.value !== 'string') throw new Error('Firefox script returned no JSON result');
    return JSON.parse(response.result.value) as T;
  }

  async evaluateExpression(context: string, expression: string, awaitPromise: boolean, deadline?: number, sandbox?: string): Promise<unknown> {
    const response = await this.connection.send<{ type?: string; result?: unknown; exceptionDetails?: { text?: string } }>(
      'script.evaluate',
      { expression, target: { context, ...(sandbox ? { sandbox } : {}) }, awaitPromise, resultOwnership: 'none' },
      deadline,
    );
    if (response.type === 'exception') throw new Error(response.exceptionDetails?.text || 'Firefox script failed');
    return fromRemoteValue(response.result);
  }

  async pointer(context: string, pointerType: 'mouse' | 'touch', actions: object[], deadline?: number): Promise<void> {
    await this.connection.send('input.performActions', {
      context,
      actions: [{ type: 'pointer', id: 'mearl-pointer', parameters: { pointerType }, actions }],
    }, deadline);
    await this.connection.send('input.releaseActions', { context }, deadline);
  }

  async keys(context: string, actions: object[], deadline?: number): Promise<void> {
    await this.connection.send('input.performActions', {
      context,
      actions: [{ type: 'key', id: 'mearl-key', actions }],
    }, deadline);
    await this.connection.send('input.releaseActions', { context }, deadline);
  }

  pageInfo(context: string, deadline?: number) {
    return this.callInPage<{ url: string; title: string; active: boolean }>(
      context,
      function pageInfo() {
        return { url: location.href, title: document.title, active: document.visibilityState === 'visible' };
      },
      [],
      deadline,
    );
  }

  locate(context: string, selector: string, deadline?: number) {
    return this.locateNode(context, selector, deadline);
  }

  async act({ action, data, deadline, browserId }: ProviderActionContext): Promise<unknown> {
    validateRequiredActionTabId(action, data);
    if (action === 'tab_list') return this.listTabs(deadline);
    if (action === 'tab_open') return this.openTab(data, deadline);
    const browserResult = await dispatchBrowserAction(this, { action, data, deadline, browserId });
    if (browserResult !== undefined || ['get_capabilities', 'get_cookie', 'set_cookie', 'send_request', 'run_actions'].includes(action)) {
      return browserResult;
    }
    const context = this.contextFor(typeof data.tabId === 'number' ? data.tabId : -1);
    if (action === 'page_press' && data.dialogId !== undefined) {
      return this.dialogsFor(context).press(data as { dialogId?: string; key: string; promptText?: string }, params =>
        this.connection.send('browsingContext.handleUserPrompt', {
          context,
          accept: params.accept,
          ...(params.promptText !== undefined ? { userText: params.promptText } : {}),
        }, deadline),
      );
    }
    if (action === 'page_press' && data.promptText !== undefined) throw new Error('page_press: promptText requires dialogId.');
    if (action === 'page_snapshot') return snapshotFirefoxPage(this, context, data, deadline);
    const run = () => this.perform(action, context, data, deadline);
    return action === 'tab_close' ? run() : this.dialogsFor(context).execute(run);
  }

  private async perform(action: string, context: string, data: JsonObject, deadline?: number): Promise<unknown> {
    switch (action) {
      case 'tab_close':
        return this.closeTab(context, data.tabId as number, deadline);
      case 'page_navigate':
        return navigateFirefoxPage(this, context, data, deadline);
      case 'page_click':
        return clickFirefoxPage(this, context, data, deadline);
      case 'page_type':
        return typeFirefoxPage(this, context, data, deadline);
      case 'page_hover':
        return hoverFirefoxPage(this, context, data, deadline);
      case 'page_scroll':
        return scrollFirefoxPage(this, context, data, deadline);
      case 'page_drag':
        return dragFirefoxPage(this, context, data, deadline);
      case 'page_press':
        return pressFirefoxPage(this, context, data, deadline);
      case 'page_eval':
        return evalFirefoxPage(this, context, data, deadline);
      case 'page_wait':
        return waitFirefoxPage(this, context, data, deadline);
      case 'page_inspect':
        return inspectFirefoxPage(this, context, data, deadline);
      case 'page_frames':
        return framesFirefoxPage(this, context, deadline);
      case 'page_upload':
        return uploadFirefoxPage(this, context, data, deadline);
      case 'page_screenshot':
        return screenshotFirefoxPage(this, context, data, deadline);
      case 'set_timezone':
        return setFirefoxTimezone(this, context, data, deadline);
      case 'set_device_emulation':
        return setFirefoxEmulation(this, context, data, deadline);
      case 'get_requests':
        return this.observation.getRequests(context, data as never);
      case 'get_logs':
        return this.observation.getLogs(context, data as never);
      case 'get_events':
        return this.observation.getEvents(context, data as never);
      case 'page_call_tool':
        return callFirefoxWebMcp(this, context, data, deadline);
      case 'tab_checkpoint':
      case 'capture_checkpoint':
        return this.observation.checkpoint(context, data.tabId as number);
      case 'set_mock':
        return this.observation.setMock(context, data as never, deadline);
      case 'get_mocks':
        return this.observation.getMocks(context, data as never);
      default:
        throw new Error(`Firefox Provider does not support ${action}`);
    }
  }

  private async listTabs(deadline?: number) {
    const contexts = await this.tree(deadline);
    const tabs = (await Promise.all(contexts.map(tab => this.describeTab(tab, deadline)))).filter(tab => tab !== undefined);
    return { tabs: tabs.map(tab => ({ id: tab.tabId, ...tab })), count: tabs.length };
  }

  private async closeTab(context: string, tabId: number, deadline?: number) {
    await this.connection.send('browsingContext.close', { context }, deadline);
    if ((await this.tree(deadline)).some(item => item.context === context)) throw new Error('Firefox kept the tab open');
    this.forgetContext(context);
    return { closed: true, tabId };
  }

  private async openTab(data: JsonObject, deadline?: number) {
    rejectOptions(data, ['closeExisting', 'restoreFocusOnClose', 'emulation', 'group', 'appProfile', 'os', 'bridgeConfig']);
    const url = nonempty(data.url, 'url');
    const { active = false, reuse = 'never', match } = data as unknown as TabOpenParams;
    if (typeof active !== 'boolean') throw new Error('active must be a boolean');
    if (!['never', 'prefer', 'require'].includes(reuse)) throw new Error('reuse must be never, prefer, or require');
    if (reuse !== 'never') {
      const existing = selectMatchingTab(await this.tree(deadline), url, match);
      if (existing) {
        if (active) await this.connection.send('browsingContext.activate', { context: existing.context }, deadline);
        const page = await this.describeTab(existing, deadline);
        if (page) return { ...page, opened: false, reused: true };
      }
      if (reuse === 'require') throw new Error('No existing Firefox tab matches the requested URL');
    }
    const { context } = await this.connection.send<{ context: string }>('browsingContext.create', { type: 'tab', background: !active }, deadline);
    try {
      await this.connection.send('browsingContext.navigate', { context, url, wait: 'interactive' }, deadline);
      const page = await this.pageInfo(context, deadline);
      return { ...page, tabId: this.tabIdFor(context), opened: true, reused: false };
    } catch (error) {
      await this.connection.send('browsingContext.close', { context }, Date.now() + 2_000).catch(() => {});
      throw error;
    }
  }

  private async tree(deadline?: number): Promise<BrowsingContext[]> {
    const { contexts } = await this.connection.send<{ contexts: BrowsingContext[] }>('browsingContext.getTree', { maxDepth: 0 }, deadline);
    return contexts;
  }

  private async describeTab({ context, url }: BrowsingContext, deadline?: number) {
    let page: { url: string; title: string; active: boolean };
    try {
      page = await this.pageInfo(context, deadline);
    } catch (error) {
      if (!(error instanceof BiDiError)) throw error;
      if (error.code === 'no such frame') return undefined;
      if (error.code !== 'unsupported operation') throw error;
      page = { url, title: '', active: false };
    }
    return { tabId: this.tabIdFor(context), ...page };
  }

  private async locateNode(context: string, value: unknown, deadline?: number) {
    const selector = nonempty(value, 'CSS selector');
    const { nodes } = await this.connection.send<{ nodes: Array<{ sharedId?: string }> }>('browsingContext.locateNodes', {
      context,
      locator: { type: 'css', value: selector },
      maxNodeCount: 1,
    }, deadline);
    if (!nodes[0]?.sharedId) throw new Error(`No Firefox element matches ${selector}`);
    return { sharedId: nodes[0].sharedId };
  }
}
