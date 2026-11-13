import {
  appendCapturedTrackingBatch,
  appendRequestToBuffer,
  captureCheckpoint,
  compileTextPattern,
  createCaptureGeneration,
  createRequestBufferAccounting,
  describeBrowserCapabilities,
  formatTrackingEvent,
  HeaderRuleSet,
  matchesTextPattern,
  nextCaptureSequence,
  prepareMockResponseHeaders,
  queryCapturedEntries,
  queryCapturedTrackingEvents,
  serializeMockResponse,
  serializeRequest,
  setValueByPath,
  TRACKING_CAPTURE_ARMED_HINT,
  type CapturedRequest,
  type ConsoleLog,
  type GetEventsParams,
  type GetLogsParams,
  type GetMocksParams,
  type GetRequestsParams,
  type RumEvent,
  type SetMockParams,
  type SetRuleParams,
} from '@mearl/browser-core';
import type { JsonObject } from '@mearl/provider';
import { parseTrackingRequest } from '@mearl/plugin-tracking';
import { FIREFOX_ACTIONS, FIREFOX_LIMITATIONS } from './capabilities.js';
import type { FirefoxBrowser } from './browser.js';
import { bytesValue } from './values.js';

const OBSERVATION_EVENTS = [
  'log.entryAdded',
  'network.beforeRequestSent',
  'network.responseCompleted',
  'browsingContext.userPromptOpened',
  'browsingContext.userPromptClosed',
  'browsingContext.contextDestroyed',
  'browsingContext.navigationStarted',
];

interface MockEntry {
  apiName: string;
  responseData: unknown;
  duration?: number;
  conditions?: Record<string, unknown>;
  enabled: boolean;
}

interface TabCapture {
  tabId: number;
  requests: CapturedRequest[];
  logs: ConsoleLog[];
  accounting: ReturnType<typeof createRequestBufferAccounting>;
  capture: {
    tabId: number;
    generation: string;
    currentSequence: number;
  };
  droppedRequests: number;
  droppedLogs: number;
  droppedEvents: number;
  events: RumEvent[];
  byRequest: Map<string, CapturedRequest>;
  mocks: Map<string, MockEntry[]>;
}

interface BidiRequest {
  request?: string;
  url?: string;
  method?: string;
  headers?: Array<{ name?: string; value?: unknown }>;
  body?: unknown;
}

function apiNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('api') || parsed.searchParams.get('apiName') || parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  } catch {
    return url;
  }
}

function headersOf(headers: BidiRequest['headers']): Array<{ name: string; value: string }> {
  return (headers ?? []).flatMap(header =>
    typeof header.name === 'string' ? [{ name: header.name, value: bytesValue(header.value) }] : [],
  );
}

function queryOf(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function isSubset(subset: unknown, superset: unknown): boolean {
  if (subset === superset) return true;
  if (subset == null || superset == null || typeof subset !== 'object' || typeof superset !== 'object') {
    return String(subset) === String(superset);
  }
  if (Array.isArray(subset)) return Array.isArray(superset) && JSON.stringify(subset) === JSON.stringify(superset);
  return Object.entries(subset).every(([key, value]) => key in (superset as object) && isSubset(value, (superset as Record<string, unknown>)[key]));
}

function requestData(url: string, postData: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  try {
    new URL(url).searchParams.forEach((value, key) => {
      try {
        data[key] = JSON.parse(value);
      } catch {
        data[key] = value;
      }
    });
  } catch {
    // The request URL can be a browser-internal address.
  }
  if (typeof postData === 'string' && postData) {
    try {
      const json = JSON.parse(postData) as unknown;
      if (json && typeof json === 'object') Object.assign(data, json);
    } catch {
      new URLSearchParams(postData).forEach((value, key) => {
        data[key] = value;
      });
    }
  }
  return data;
}

function sameConditions(left?: Record<string, unknown>, right?: Record<string, unknown>): boolean {
  const leftKeys = left ? Object.keys(left) : [];
  const rightKeys = right ? Object.keys(right) : [];
  if (!leftKeys.length || !rightKeys.length) return leftKeys.length === rightKeys.length;
  return leftKeys.length === rightKeys.length && leftKeys.every(key => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]));
}

export class FirefoxObservation {
  private armed = false;
  private collector?: string;
  private intercept?: string;
  private readonly rules = new HeaderRuleSet();
  private observationError?: string;
  private readonly tabs = new Map<string, TabCapture>();

  constructor(private readonly browser: FirefoxBrowser) {}

  async arm(deadline?: number): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    this.bind();
    try {
      await this.browser.connection.send('session.subscribe', { events: OBSERVATION_EVENTS }, deadline);
    } catch (error) {
      this.observationError = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const result = await this.browser.connection.send<{ collector?: string }>(
        'network.addDataCollector',
        { dataTypes: ['response'], maxEncodedDataSize: 1_000_000 },
        deadline,
      );
      this.collector = result.collector;
    } catch {
      // Response bodies remain unavailable, but request metadata still records.
    }
  }

  private bind(): void {
    const { connection } = this.browser;
    connection.on('log.entryAdded', params => this.recordLog(params));
    connection.on('network.beforeRequestSent', params => void this.recordRequest(params, false));
    connection.on('network.responseCompleted', params => void this.recordRequest(params, true));
    connection.on('browsingContext.userPromptOpened', params => this.promptOpened(params));
    connection.on('browsingContext.userPromptClosed', params => this.promptClosed(params));
    connection.on('browsingContext.contextDestroyed', params => {
      const context = this.contextOf(params);
      if (!context) return;
      this.tabs.delete(context);
      this.browser.forgetContext(context);
    });
    connection.on('browsingContext.navigationStarted', params => {
      const context = this.contextOf(params);
      if (!context) return;
      this.browser.clearRefs(context);
      // Navigation drops element refs. An open native dialog is gone with the old page.
      // A click that starts navigation has no dialog, and must still finish.
      const dialogs = this.browser.dialogsFor(context);
      if (dialogs.pending) dialogs.invalidate();
      this.browser.resetWebMcp(context);
    });
  }

  private contextOf(params: unknown): string | undefined {
    const context = (params as { context?: unknown } | null)?.context;
    return typeof context === 'string' ? context : undefined;
  }

  private capture(context: string): TabCapture {
    const existing = this.tabs.get(context);
    if (existing) return existing;
    const tabId = this.browser.tabIdFor(context);
    const created: TabCapture = {
      tabId,
      requests: [],
      logs: [],
      accounting: createRequestBufferAccounting(),
      capture: { tabId, generation: createCaptureGeneration(), currentSequence: 0 },
      droppedRequests: 0,
      droppedLogs: 0,
      droppedEvents: 0,
      events: [],
      byRequest: new Map(),
      mocks: new Map(),
    };
    this.tabs.set(context, created);
    return created;
  }

  private recordLog(params: unknown): void {
    const event = params as { context?: unknown; source?: { context?: string }; level?: string; text?: string; type?: string; timestamp?: number };
    const context = typeof event.source?.context === 'string' ? event.source.context : this.contextOf(event);
    if (!context) return;
    const state = this.capture(context);
    const message = typeof event.text === 'string' ? event.text : '';
    state.logs.push({
      level: event.level === 'warning' ? 'warn' : event.level || 'info',
      message,
      timestampMs: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      args: message ? [message] : [],
      captureSequence: nextCaptureSequence(state.capture),
      origin: event.type === 'javascript' ? 'exception' : 'console',
    });
    if (state.logs.length > 500) {
      const removed = state.logs.shift();
      if (removed) state.droppedLogs = Math.max(state.droppedLogs, removed.captureSequence);
    }
  }

  private async recordRequest(params: unknown, completed: boolean): Promise<void> {
    const event = params as {
      context?: string;
      isBlocked?: boolean;
      navigation?: string;
      request?: BidiRequest;
      response?: { status?: number; statusText?: string; headers?: BidiRequest['headers'] };
      timestamp?: number;
    };
    if (!event.context || !event.request?.request || !event.request.url) return;
    const state = this.capture(event.context);
    const requestId = event.request.request;
    const started = state.byRequest.get(requestId);
    const now = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
    const postData = bytesValue(event.request.body);
    let responseBody: unknown = started?.responseBody ?? null;
    if (completed && this.collector) {
      try {
        const data = await this.browser.connection.send<{ bytes?: unknown }>('network.getData', {
          dataType: 'response',
          request: requestId,
          collector: this.collector,
        });
        const text = bytesValue(data.bytes);
        if (text) {
          try {
            responseBody = JSON.parse(text);
          } catch {
            responseBody = text;
          }
        }
      } catch {
        // The collector can expire a body before the query reads it.
      }
    }
    const record: CapturedRequest = {
      id: started?.id ?? state.requests.length + 1,
      timestamp: new Date(now).toISOString(),
      timestampMs: now,
      method: event.request.method || 'GET',
      url: event.request.url,
      apiName: apiNameFromUrl(event.request.url),
      status: event.response?.status ?? started?.status ?? 0,
      statusText: event.response?.statusText ?? started?.statusText ?? '',
      headers: headersOf(event.request.headers),
      responseHeaders: headersOf(event.response?.headers),
      queryString: queryOf(event.request.url),
      postData: postData || started?.postData || null,
      responseBody,
      isProxy: false,
      proxyRequestUrl: null,
      proxyData: null,
      source: 'requests',
      isPending: !completed,
      captureSequence: started?.captureSequence ?? nextCaptureSequence(state.capture),
      ...(started?.timestampMs ? { duration: Math.max(0, now - started.timestampMs) } : {}),
    };
    if (started) {
      const index = state.requests.indexOf(started);
      if (index >= 0) state.requests[index] = record;
      state.byRequest.set(requestId, record);
    } else {
      const removed = appendRequestToBuffer(state.requests, state.accounting, record);
      for (const entry of removed) state.droppedRequests = Math.max(state.droppedRequests, entry.captureSequence ?? 0);
      state.byRequest.set(requestId, record);
    }
    if (!started) this.recordTracking(state, record);
    if (event.isBlocked) {
      // BiDi does not identify the parent frame on an intercepted request.
      const resourceType = event.navigation ? 'main_frame' : 'xmlhttprequest';
      await this.fulfillOrContinue(event.context, record, requestId, resourceType);
    }
  }

  private recordTracking(state: TabCapture, request: CapturedRequest): void {
    const postData = typeof request.postData === 'string' ? request.postData : undefined;
    const captureSequence = request.captureSequence;
    if (!Number.isSafeInteger(captureSequence)) return;
    const parsed = parseTrackingRequest(request.url, postData, { sequence: captureSequence, now: request.timestampMs });
    if (!parsed.length) return;
    const removed = appendCapturedTrackingBatch(
      state.events,
      parsed.map(event => ({ ...event, captureSequence })),
      500,
    );
    for (const event of removed) {
      if (event.captureSequence !== undefined) state.droppedEvents = Math.max(state.droppedEvents, event.captureSequence);
    }
  }

  private matchedMock(state: TabCapture, request: CapturedRequest): MockEntry | undefined {
    const data = requestData(request.url, request.postData);
    for (const list of state.mocks.values()) {
      for (const mock of list) {
        if (!mock.enabled || request.method === 'OPTIONS') continue;
        if (!request.url.includes(mock.apiName) && !request.apiName.includes(mock.apiName)) continue;
        if (!mock.conditions || !Object.keys(mock.conditions).length || isSubset(mock.conditions, data) || isSubset(mock.conditions, data.data)) {
          return mock;
        }
      }
    }
    return undefined;
  }

  private async fulfillOrContinue(context: string, request: CapturedRequest, requestId: string, resourceType: string): Promise<void> {
    const mock = this.matchedMock(this.capture(context), request);
    try {
      if (!mock) {
        const headers = this.rules.apply(request.url, resourceType, request.headers);
        await this.browser.connection.send('network.continueRequest', {
          request: requestId,
          ...(headers ? { headers: headers.map(header => ({ name: header.name, value: { type: 'string', value: header.value } })) } : {}),
        });
        return;
      }
      if (mock.duration && mock.duration > 0) await new Promise(resolve => setTimeout(resolve, mock.duration));
      const { body, isJsonp } = serializeMockResponse(request.url, mock.responseData);
      const headers = prepareMockResponseHeaders(
        [
          { name: 'content-type', value: 'application/json; charset=utf-8' },
          { name: 'x-mock-by', value: 'mearl-firefox' },
          { name: 'access-control-allow-origin', value: '*' },
        ],
        isJsonp,
      );
      await this.browser.connection.send('network.provideResponse', {
        request: requestId,
        statusCode: 200,
        reasonPhrase: 'OK',
        headers: headers.map(header => ({ name: header.name, value: { type: 'string', value: header.value } })),
        body: { type: 'string', value: body },
      });
      request.responseBody = mock.responseData;
      request.status = 200;
      request.isPending = false;
    } catch {
      await this.browser.connection.send('network.continueRequest', { request: requestId }).catch(() => {});
    }
  }

  private promptOpened(params: unknown): void {
    const event = params as { context?: string; type?: string; message?: string; defaultValue?: string };
    if (!event.context) return;
    this.browser.dialogsFor(event.context).opened({
      type: event.type,
      message: event.message,
      defaultPrompt: event.defaultValue,
    });
  }

  private promptClosed(params: unknown): void {
    const context = this.contextOf(params);
    if (context) this.browser.dialogsFor(context).closed();
  }

  private require(context: string): TabCapture {
    if (this.observationError) throw new Error(`Firefox observation is unavailable: ${this.observationError}`);
    return this.capture(context);
  }

  getRequests(context: string, data: GetRequestsParams) {
    const state = this.require(context);
    const pattern = data.filter ? compileTextPattern(data.filter) : undefined;
    const captured = queryCapturedEntries(
      state.requests.filter((request): request is CapturedRequest & { captureSequence: number } =>
        Number.isSafeInteger(request.captureSequence),
      ),
      state.capture,
      { after: data.after, since: data.since, limit: data.count ?? 10 },
      request =>
        (!data.source || data.source === 'all' || request.source === data.source) &&
        (!pattern || matchesTextPattern(request.url, pattern) || matchesTextPattern(request.apiName, pattern)),
      state.droppedRequests,
      'requests',
    );
    return {
      meta: {
        count: captured.entries.length,
        totalMatched: captured.totalMatched,
        totalInBuffer: state.requests.length,
        filter: data.filter,
        since: data.since,
        after: data.after,
        nextCursor: captured.nextCursor,
        hasMore: captured.hasMore,
        gap: captured.gap,
        source: 'bidi',
      },
      requests: captured.entries.map(request =>
        serializeRequest(request, {
          includeBody: data.includeBody ?? !data.fields?.length,
          includeHeaders: data.includeHeaders === true,
          maxBodySize: data.maxBodySize ?? 50000,
          fields: data.fields,
          keysOnly: data.keysOnly === true,
        }),
      ),
    };
  }

  getLogs(context: string, data: GetLogsParams) {
    const state = this.require(context);
    const { level, since, after, limit = 100, filter } = data;
    const pattern = filter ? compileTextPattern(filter) : undefined;
    const captured = queryCapturedEntries(
      state.logs,
      state.capture,
      { after, since, limit },
      log =>
        (!level || level === 'all' || log.level === level) &&
        (!pattern || matchesTextPattern(log.message, pattern) || log.args.some(arg => matchesTextPattern(arg, pattern))),
      state.droppedLogs,
      'logs',
    );
    const captureStatus = state.logs.length === 0 ? 'armed' : 'active';
    return {
      meta: {
        count: captured.entries.length,
        totalMatched: captured.totalMatched,
        totalInBuffer: state.logs.length,
        level: level || 'all',
        since,
        after,
        filter,
        nextCursor: captured.nextCursor,
        hasMore: captured.hasMore,
        gap: captured.gap,
        captureStatus,
        ...(captureStatus === 'armed'
          ? { hint: 'Log capture is active, but this tab has no captured history yet. Reload the current tab or repeat the triggering action, then call get_logs again.' }
          : {}),
        source: 'bidi',
      },
      logs: captured.entries,
    };
  }

  checkpoint(context: string, tabId: number) {
    const state = this.require(context);
    return {
      tabId,
      cursor: captureCheckpoint(state.capture),
      timestampMs: Date.now(),
      captureStatus: state.capture.currentSequence === 0 ? 'armed' : 'active',
    };
  }

  async setMock(context: string, data: SetMockParams, deadline?: number) {
    const { apiName, mockData, fields, enabled, duration, conditions } = data ?? {};
    if (!apiName || typeof apiName !== 'string' || !apiName.trim()) throw new Error('Invalid apiName');
    const state = this.require(context);
    if (enabled === false) {
      state.mocks.delete(apiName);
      await this.refreshIntercept(deadline);
      return { success: true, affectedCount: 1, message: `Mock disabled for ${apiName}` };
    }
    if (mockData === undefined && (!fields || fields.length === 0)) throw new Error('Either mockData or fields must be provided');
    if (fields && fields.length > 100) throw new Error('Too many fields: maximum 100 fields allowed');
    if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 120_000)) {
      throw new Error('duration must be a number of milliseconds from 0 to 120000');
    }
    const normConditions = conditions && Object.keys(conditions).length > 0 ? conditions : undefined;
    let finalMockData = mockData;
    if (fields && fields.length > 0) {
      const base = [...state.requests].reverse().find(request =>
        request.method !== 'OPTIONS' &&
        request.responseBody != null &&
        (request.apiName.includes(apiName) || request.url.includes(apiName)) &&
        (!normConditions || isSubset(normConditions, requestData(request.url, request.postData))),
      );
      finalMockData = base?.responseBody ? JSON.parse(JSON.stringify(base.responseBody)) : {};
      for (const field of fields) setValueByPath(finalMockData, field.path, field.value);
    }
    const list = state.mocks.get(apiName) ?? [];
    const entry = { apiName, responseData: finalMockData, duration, conditions: normConditions, enabled: true };
    const index = list.findIndex(mock => sameConditions(mock.conditions, normConditions));
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    state.mocks.set(apiName, list);
    await this.refreshIntercept(deadline);
    return { success: true, affectedCount: 1, message: `Mock set for ${apiName}` };
  }

  getMocks(context: string, data: GetMocksParams) {
    const state = this.require(context);
    let matcher: RegExp | undefined;
    if (data?.apiName) {
      try {
        matcher = new RegExp(data.apiName, 'i');
      } catch {
        throw new Error('Invalid apiName pattern');
      }
    }
    const mocks = [...state.mocks.values()].flat().filter(mock => !matcher || matcher.test(mock.apiName)).map(mock => ({
      apiName: mock.apiName,
      responseData: mock.responseData,
      duration: mock.duration ?? 0,
      conditions: mock.conditions,
      disabled: !mock.enabled,
    }));
    return { mocks, count: mocks.length };
  }

  async setRule(data: SetRuleParams, deadline?: number) {
    const result = data?.enabled === false ? this.rules.remove(data.ruleId) : this.rules.add(data);
    await this.refreshIntercept(deadline);
    return result;
  }

  getRules() {
    return this.rules.list();
  }

  getEvents(context: string, data: GetEventsParams) {
    const state = this.require(context);
    const { source = 'all', event_type, since, after, limit = 20, filter, includeRaw = false } = data;
    const response = queryCapturedTrackingEvents(
      state.events,
      state.capture,
      { source, event_type, since, after, limit, filter },
      state.droppedEvents,
    );
    const captureStatus = response.totalInBuffer === 0 ? 'armed' : 'active';
    return {
      meta: {
        count: response.events.length,
        totalMatched: response.totalMatched,
        totalInBuffer: response.totalInBuffer,
        source,
        captureStatus,
        captureSource: 'bidi',
        includeRaw,
        after,
        nextCursor: response.nextCursor,
        hasMore: response.hasMore,
        gap: response.gap,
        ...(response.events.length === 0 && captureStatus === 'armed' ? { hint: TRACKING_CAPTURE_ARMED_HINT } : {}),
      },
      events: response.events.map(event => formatTrackingEvent(event, includeRaw)),
    };
  }

  private async refreshIntercept(deadline?: number): Promise<void> {
    const mocks = [...this.tabs.values()].some(state => [...state.mocks.values()].some(list => list.some(mock => mock.enabled)));
    const needed = mocks || this.rules.size > 0;
    if (needed && !this.intercept) {
      const result = await this.browser.connection.send<{ intercept?: string }>(
        'network.addIntercept',
        { phases: ['beforeRequestSent'] },
        deadline,
      );
      this.intercept = result.intercept;
    } else if (!needed && this.intercept) {
      const intercept = this.intercept;
      this.intercept = undefined;
      await this.browser.connection.send('network.removeIntercept', { intercept }, deadline).catch(() => {});
    }
  }
}

export function describeFirefoxCapabilities(data: JsonObject | undefined) {
  const described = describeBrowserCapabilities(FIREFOX_ACTIONS, undefined, data);
  described.limitations.push(...FIREFOX_LIMITATIONS);
  return described;
}
