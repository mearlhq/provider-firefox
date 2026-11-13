import {
  INVALID_NATIVE_SELECTOR_HINT,
  INSPECT_ELEMENTS_IN_PAGE_SOURCE,
  PAGE_CLICK_HIDDEN_TOUCH_ERROR,
  SCROLL_ELEMENT_IN_PAGE_SOURCE,
  buildPageDragDomExpression,
  buildPageDragPath,
  buildPageInspectExpression,
  buildPagePressDomExpression,
  buildPageScrollExpression,
  buildPageWaitExpression,
  checkPageActionPrecondition,
  clickElementViaJS,
  countSnapshotNodes,
  createPageClickResult,
  filterSnapshotTree,
  filterSnapshotTreeByQuery,
  formatAXTextMatchCandidates,
  formatSnapshotNode,
  formatSnapshotWithLimits,
  getClickCoordsFromNode,
  getDragCoordsFromNode,
  hasInteractiveSnapshotNode,
  isStateAwareClickTarget,
  limitPageSnapshotQueryMatches,
  matchAXNodesByText,
  pageDialogSnapshot,
  readPageWaitEvaluationError,
  resolvePageClickDispatchPolicy,
  resolvePageDragDispatchPolicy,
  resolvePageDragInput,
  resolvePageEvalExpression,
  validatePageUserScriptParams,
  resolvePageInspectInput,
  resolvePageNavigateInput,
  resolvePagePressDispatchPolicy,
  resolvePagePressInput,
  resolvePageScrollInput,
  resolvePageSnapshotQuery,
  resolvePageWaitInput,
  typeIntoElement,
  unwrapPageDragDomResult,
  unwrapPageInspectResult,
  unwrapPagePressDomResult,
  unwrapPageScrollResult,
  validatePageElementSelector,
  type PageClickDispatchTarget,
  type PageClickParams,
  type PageClickRequestedTarget,
  type PageDragEndpoint,
  type PageDragParams,
  type PageEvalParams,
  type PageHoverParams,
  type PageInspectParams,
  type PageNavigateParams,
  type PagePressDomExecutionResult,
  type PagePressParams,
  type PageScrollExecutionResult,
  type PageScrollParams,
  type PageSnapshotMode,
  type PageSnapshotParams,
  type PageSnapshotQueryMatch,
  type PageTypeParams,
  type PageUploadParams,
  type PageWaitParams,
  type SnapshotNodeBase,
  PageActionPreconditionError,
} from '@mearl/browser-core';
import type { JsonObject } from '@mearl/provider';
import type { FirefoxBrowser, FirefoxRef } from './browser.js';
import { collectNamedElements, collectPageSnapshot, type FirefoxSnapshotNode } from './dom.js';
import { refreshFirefoxWebMcp } from './webmcp.js';

const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  Delete: '\uE017',
  ArrowUp: '\uE013',
  ArrowDown: '\uE015',
  ArrowLeft: '\uE012',
  ArrowRight: '\uE014',
  Home: '\uE011',
  End: '\uE010',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  Space: ' ',
};
const MODIFIER_KEYS = { Alt: '\uE00A', Control: '\uE009', Meta: '\uE03D', Shift: '\uE008' };

async function visibility(browser: FirefoxBrowser, context: string, deadline?: number): Promise<string | undefined> {
  const state = await browser.evaluateExpression(context, 'document.visibilityState', false, deadline);
  return typeof state === 'string' ? state : undefined;
}

async function coordsFor(
  browser: FirefoxBrowser,
  context: string,
  selector: string,
  deadline?: number,
): Promise<PageClickDispatchTarget & { x: number; y: number; inputType?: string; error?: string }> {
  const element = await browser.locate(context, browser.resolveSelector(context, selector), deadline);
  const result = await browser.callInPage<PageClickDispatchTarget & { x: number; y: number; inputType?: string; error?: string } | null>(
    context,
    `function(){if(this&&this.scrollIntoView)this.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});return (${getClickCoordsFromNode.toString()}).call(this);}`,
    [],
    deadline,
    element,
  );
  if (!result) throw new PageActionPreconditionError(`No Firefox element matches ${selector}`);
  if (result.error) throw new PageActionPreconditionError(result.error);
  return result;
}

async function clickDom(
  browser: FirefoxBrowser,
  context: string,
  selector: string,
  expectedText: string | undefined,
  deadline?: number,
): Promise<PageClickDispatchTarget> {
  const element = await browser.locate(context, browser.resolveSelector(context, selector), deadline);
  const value = await browser.callInPage<{ error?: string } & PageClickDispatchTarget>(
    context,
    clickElementViaJS,
    [expectedText],
    deadline,
    element,
  );
  if (!value || value.error) throw new PageActionPreconditionError(value?.error || 'Cannot resolve clickable element');
  return { ...value, dispatchMode: 'dom' };
}

export async function clickFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const { selector, text, role, exact, scope, clickMode, point, frameId, coordinateSpace } = data as unknown as PageClickParams;
  const hasSelector = typeof selector === 'string' && selector.length > 0;
  const hasText = typeof text === 'string' && text.length > 0;
  const hasPoint = Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0);
  const provided = [hasSelector && 'selector', hasText && 'text', hasPoint && 'point'].filter(Boolean) as string[];
  if (clickMode !== undefined && !['auto', 'dom', 'mouse', 'touch'].includes(clickMode)) {
    throw new PageActionPreconditionError('page_click: "clickMode" must be one of auto, dom, mouse, touch');
  }
  if (scope !== undefined && !hasText) throw new PageActionPreconditionError('page_click: "scope" is only supported with the "text" target');
  if (coordinateSpace !== undefined && !['outer-viewport', 'active-frame'].includes(coordinateSpace)) {
    throw new PageActionPreconditionError('page_click: "coordinateSpace" must be one of outer-viewport, active-frame');
  }
  if (coordinateSpace !== undefined && !hasPoint) {
    throw new PageActionPreconditionError('page_click: "coordinateSpace" is only supported with the "point" target');
  }
  if (frameId !== undefined || coordinateSpace === 'active-frame') {
    throw new PageActionPreconditionError('page_click: frameId and active-frame coordinates require the browser extension backend');
  }
  if (scope !== undefined) checkPageActionPrecondition(() => validatePageElementSelector(scope, 'page_click scope'));
  if (hasSelector) checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_click'));
  if (provided.length !== 1) {
    throw new PageActionPreconditionError(
      provided.length === 0
        ? 'page_click: provide exactly one of "selector", "text", or "point". For text matching, pass "text" (and optionally "role"/"exact"). For coordinate clicks, pass "point": { x, y } in viewport pixels.'
        : `page_click: provide exactly one of "selector", "text", or "point" — got ${provided.length} (${provided.join(', ')}).`,
    );
  }
  const visible = await visibility(browser, context, deadline);
  if (clickMode === 'touch' && visible === 'hidden') throw new PageActionPreconditionError(PAGE_CLICK_HIDDEN_TOUCH_ERROR);
  const policy = resolvePageClickDispatchPolicy(clickMode, visible, browser.touch.has(context));
  const mode = policy.clickMode === 'dom' ? 'dom' : policy.clickMode;
  const finalize = (result: ReturnType<typeof createPageClickResult>) =>
    policy.fallbackReason ? { ...result, fallbackReason: policy.fallbackReason } : result;

  let targetSelector = selector as string | undefined;
  let requested: PageClickRequestedTarget;
  if (hasText) {
    const found = await browser.callInPage<{ nodes?: Array<{ selector: string; role: string; name: string }>; error?: string }>(
      context,
      collectNamedElements,
      [typeof scope === 'string' ? scope : null],
      deadline,
    );
    if (found.error) throw new PageActionPreconditionError(found.error);
    const { hits } = matchAXNodesByText(
      (found.nodes ?? []).map((node, index) => ({ nodeId: String(index), role: { value: node.role }, name: { value: node.name }, backendDOMNodeId: index })),
      { text: text as string, role, exact },
    );
    if (hits.length !== 1) {
      const exactSuffix = exact === false ? ' (substring match)' : '';
      const roleSuffix = role ? ` with role "${role}"` : '';
      throw new PageActionPreconditionError(
        hits.length === 0
          ? `page_click: text "${text}"${roleSuffix}${exactSuffix}${scope ? ` in scope "${scope}"` : ''} not found. Run page_snapshot to inspect the page, or try exact: false for substring matching.`
          : `page_click: text "${text}"${roleSuffix} matched ${hits.length} elements. Pass role or exact, or use a snapshot ref.\n${formatAXTextMatchCandidates(hits)}`,
      );
    }
    targetSelector = found.nodes![hits[0]!.backendNodeId]!.selector;
    requested = { kind: 'text', name: hits[0]!.name, role: hits[0]!.role, ...(scope ? { scope } : {}) };
  } else if (hasPoint) {
    await browser.pointer(context, mode === 'touch' ? 'touch' : 'mouse', [
      { type: 'pointerMove', origin: 'viewport', x: Math.round(point!.x), y: Math.round(point!.y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ], deadline);
    return finalize(createPageClickResult(
      { kind: 'point', point: { x: point!.x, y: point!.y } },
      { tag: '', text: '', dispatchMode: 'trusted-input', pointerType: mode === 'touch' ? 'touch' : 'mouse', coordinates: { coordinateSpace: 'outer-viewport', outerPoint: { x: point!.x, y: point!.y } } },
    ));
  } else {
    const ref = browser.refFor(context, selector as string);
    requested = ref
      ? { kind: 'ref', selector, role: ref.role, name: ref.name }
      : { kind: 'selector', selector };
  }
  const coord = mode === 'dom' ? undefined : await coordsFor(browser, context, targetSelector!, deadline);
  if (mode !== 'dom' && !(policy.stateAwareControls && coord && isStateAwareClickTarget(coord))) {
    const pointerType = mode === 'touch' ? 'touch' : 'mouse';
    await browser.pointer(context, pointerType, [
      { type: 'pointerMove', origin: 'viewport', x: Math.round(coord!.x), y: Math.round(coord!.y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ], deadline);
    return finalize(createPageClickResult(requested, { ...coord!, dispatchMode: 'trusted-input', pointerType }));
  }
  return finalize(createPageClickResult(requested, await clickDom(browser, context, targetSelector!, requested.name, deadline)));
}

export async function typeFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const { selector, text, clearFirst = true } = data as unknown as PageTypeParams;
  if (!selector || typeof selector !== 'string') {
    throw new PageActionPreconditionError('"selector" must be a non-empty string. Pass a native CSS selector or a snapshot ref like "@e3".');
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_type'));
  if (typeof text !== 'string') throw new PageActionPreconditionError('"text" must be a string.');
  const element = await browser.locate(context, browser.resolveSelector(context, selector), deadline);
  const value = await browser.callInPage<{ typed: boolean; tag: string; error?: string }>(
    context,
    `function(element, value, clear){return (${typeIntoElement.toString()})(element, value, clear);}`,
    [element, text, clearFirst !== false],
    deadline,
  );
  if (!value?.typed) throw new PageActionPreconditionError(value?.error || 'Firefox could not type into the element');
  return { typed: true, tag: value.tag };
}

export async function hoverFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const { selector } = data as unknown as PageHoverParams;
  if (typeof selector !== 'string' || !selector) {
    throw new PageActionPreconditionError('page_hover: "selector" is required (CSS selector or @eN snapshot ref)');
  }
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_hover'));
  const coord = await coordsFor(browser, context, selector, deadline);
  await browser.pointer(context, 'mouse', [
    { type: 'pointerMove', origin: 'viewport', x: Math.round(coord.x), y: Math.round(coord.y) },
  ], deadline);
  return { hovered: true, tag: coord.tag, text: coord.text };
}

export async function scrollFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = checkPageActionPrecondition(() => resolvePageScrollInput(data as unknown as PageScrollParams));
  if (input.selector?.startsWith('@e')) {
    const element = await browser.locate(context, browser.resolveSelector(context, input.selector), deadline);
    const result = await browser.callInPage<PageScrollExecutionResult>(
      context,
      `function(direction, distance, target, policy){return (${SCROLL_ELEMENT_IN_PAGE_SOURCE}).call(this, direction, distance, target, policy);}`,
      [input.direction, input.distance, input.selector, input.containerPolicy],
      deadline,
      element,
    );
    return unwrapPageScrollResult(result, `Cannot resolve scroll container for ref ${input.selector}`);
  }
  const result = await browser.evaluateExpression(context, buildPageScrollExpression(input), false, deadline);
  return unwrapPageScrollResult(result as PageScrollExecutionResult, 'page_scroll evaluation returned no value');
}

async function dragPoint(browser: FirefoxBrowser, context: string, endpoint: PageDragEndpoint, deadline?: number) {
  if (typeof endpoint !== 'string') return { requested: endpoint, point: { x: endpoint.x, y: endpoint.y } };
  const element = await browser.locate(context, browser.resolveSelector(context, endpoint), deadline);
  const coord = await browser.callInPage<{ x: number; y: number; tag: string; text: string; error?: string } | null>(
    context,
    `function(){return (${getDragCoordsFromNode.toString()}).call(this);}`,
    [],
    deadline,
    element,
  );
  if (!coord || coord.error) throw new PageActionPreconditionError(coord?.error || `No Firefox element matches ${endpoint}`);
  return { requested: endpoint, point: { x: coord.x, y: coord.y }, tag: coord.tag, text: coord.text };
}

export async function dragFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = checkPageActionPrecondition(() => resolvePageDragInput(data as unknown as PageDragParams));
  const from = await dragPoint(browser, context, input.from, deadline);
  const to = await dragPoint(browser, context, input.to, deadline);
  const visible = await visibility(browser, context, deadline);
  const policy = resolvePageDragDispatchPolicy(input.dragMode, visible, browser.touch.has(context));
  const path = buildPageDragPath(from.point, to.point, input.durationMs);
  if (policy.dispatchMode === 'dom') {
    const result = await browser.evaluateExpression(
      context,
      buildPageDragDomExpression(from.point, path.points, policy.pointerType),
      false,
      deadline,
    );
    const unwrapped = unwrapPageDragDomResult(result as { dragged: true; steps: number } | { dragged: false; steps: number; error: string });
    return { dragged: true, from, to, dispatchMode: 'dom', pointerType: policy.pointerType, durationMs: input.durationMs, steps: unwrapped.steps, ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}) };
  }
  await browser.pointer(context, policy.pointerType, [
    { type: 'pointerMove', origin: 'viewport', x: Math.round(from.point.x), y: Math.round(from.point.y) },
    { type: 'pointerDown', button: 0 },
    ...path.points.map(point => ({ type: 'pointerMove', origin: 'viewport', x: Math.round(point.x), y: Math.round(point.y), duration: path.intervalMs })),
    { type: 'pointerUp', button: 0 },
  ], deadline);
  return { dragged: true, from, to, dispatchMode: 'trusted-input', pointerType: policy.pointerType, durationMs: input.durationMs, steps: path.points.length, ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}) };
}

export async function pressFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = checkPageActionPrecondition(() => resolvePagePressInput(data as unknown as PagePressParams));
  const visible = input.pressMode === 'auto' ? await visibility(browser, context, deadline) : undefined;
  const policy = resolvePagePressDispatchPolicy(input.pressMode, visible);
  if (policy.dispatchMode === 'dom') {
    const result = unwrapPagePressDomResult(
      (await browser.evaluateExpression(context, buildPagePressDomExpression(input), false, deadline)) as PagePressDomExecutionResult,
    );
    return { ...result, key: input.key, dispatchMode: 'dom', ...(policy.fallbackReason ? { fallbackReason: policy.fallbackReason } : {}) };
  }
  const key = SPECIAL_KEYS[input.key];
  const actions = [
    ...input.modifiers.map(modifier => ({ type: 'keyDown', value: MODIFIER_KEYS[modifier] })),
    { type: 'keyDown', value: key },
    { type: 'keyUp', value: key },
    ...[...input.modifiers].reverse().map(modifier => ({ type: 'keyUp', value: MODIFIER_KEYS[modifier] })),
  ];
  await browser.keys(context, actions, deadline);
  return { pressed: true, key: input.key, dispatchMode: 'trusted-input' };
}

export async function evalFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const params = data as unknown as PageEvalParams;
  if (params.executionWorld !== undefined && params.executionWorld !== 'main' && params.executionWorld !== 'isolated') {
    throw new Error('Invalid page executionWorld');
  }
  let expression: string;
  try {
    expression = resolvePageEvalExpression(params);
  } catch (error) {
    throw new PageActionPreconditionError(error instanceof Error ? error.message : String(error));
  }
  const target = typeof params.frameId === 'string' && params.frameId ? params.frameId : context;
  if (params.executionWorld === 'isolated') {
    validatePageUserScriptParams({ tabId: params.tabId, worldId: params.worldId ?? '', code: expression });
    return { result: await browser.evaluateExpression(target, expression, true, deadline, `mearl-${params.worldId}`) };
  }
  return { result: await browser.evaluateExpression(target, expression, params.awaitPromise !== false, deadline) };
}

export async function waitFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const options = resolvePageWaitInput(data as unknown as PageWaitParams);
  const startedAt = Date.now();
  const remaining = () => (deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now());
  if (options.mode === 'time') {
    const time = Math.min(options.time ?? 0, Math.max(0, remaining()));
    if ((options.time ?? 0) > remaining()) throw new Error('page_wait: request deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, time));
    return { success: true, waited: true, elapsed: time, mode: options.mode };
  }
  const expression = buildPageWaitExpression(options);
  while (Date.now() - startedAt < options.timeout) {
    if (remaining() <= 0) throw new Error('page_wait: request deadline exceeded');
    const value = await browser.evaluateExpression(context, expression, options.mode === 'condition', deadline);
    const evaluationError = readPageWaitEvaluationError(value);
    if (evaluationError) throw new PageActionPreconditionError(evaluationError);
    if (value) return { success: true, waited: true, elapsed: Date.now() - startedAt, mode: options.mode, value };
    await new Promise(resolve => setTimeout(resolve, Math.min(options.interval, Math.max(0, remaining()))));
  }
  if (options.mode === 'selector') {
    throw new Error(`page_wait selector ${JSON.stringify(options.selector)} did not reach state ${JSON.stringify(options.state)} after ${options.timeout}ms.`);
  }
  if (options.mode === 'text') throw new Error(`page_wait text ${JSON.stringify(options.text)} was not found after ${options.timeout}ms.`);
  throw new Error(`page_wait condition was not met after ${options.timeout}ms.`);
}

export async function inspectFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = checkPageActionPrecondition(() => resolvePageInspectInput(data as unknown as PageInspectParams));
  if (input.selector === '$0') {
    throw new PageActionPreconditionError('page_inspect selector "$0" requires the browser extension and an element selected in DevTools.');
  }
  if (input.selector?.startsWith('@e')) {
    const element = await browser.locate(context, browser.resolveSelector(context, input.selector), deadline);
    const result = await browser.callInPage(
      context,
      `function(filter, styles, maxResults, invalidSelectorHint, includeOuterHTML){return (${INSPECT_ELEMENTS_IN_PAGE_SOURCE}).call(this, undefined, filter, styles, maxResults, invalidSelectorHint, includeOuterHTML);}`,
      [input.filter, input.styles, input.maxResults, INVALID_NATIVE_SELECTOR_HINT, input.includeOuterHTML],
      deadline,
      element,
    );
    return unwrapPageInspectResult(result as never, 'page_inspect evaluation returned no value');
  }
  return unwrapPageInspectResult(
    await browser.evaluateExpression(context, buildPageInspectExpression(input), false, deadline) as never,
    'page_inspect evaluation returned no value',
  );
}

function snapshotNode(
  node: FirefoxSnapshotNode,
  refs: Map<string, FirefoxRef>,
  visible: Set<number>,
  next: { id: number; ref: number },
): SnapshotNodeBase {
  const id = next.id++;
  if (node.inViewport) visible.add(id);
  const ref = node.selector && node.role !== 'RootWebArea' ? `@e${next.ref++}` : undefined;
  if (ref) refs.set(ref, { selector: node.selector, role: node.role, name: node.name });
  return {
    role: node.role,
    name: node.name,
    backendDOMNodeId: id,
    ...(ref ? { ref } : {}),
    ...(node.value ? { value: node.value } : {}),
    ...(node.focused ? { focused: true } : {}),
    ...(node.checked !== undefined ? { checked: node.checked } : {}),
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.expanded !== undefined ? { expanded: node.expanded } : {}),
    ...(node.selected ? { selected: true } : {}),
    ...(node.children?.length
      ? { children: node.children.map(child => snapshotNode(child, refs, visible, next)) }
      : {}),
  };
}

export async function snapshotFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const params = data as unknown as PageSnapshotParams;
  if (params?.includeWebMcp !== undefined && params.includeWebMcp !== 'full') {
    throw new Error('Firefox page_snapshot includeWebMcp must be "full"');
  }
  const dialog = pageDialogSnapshot(browser.dialogsFor(context), params?.mode, params?.maxChars);
  if (dialog) {
    const page = await browser.pageInfo(context, deadline);
    return { ...dialog, url: page.url, title: page.title };
  }
  const mode: PageSnapshotMode = params?.mode ?? 'full';
  const rootSelector = params?.rootSelector;
  const rootRef = params?.rootRef;
  const ancestorDepth = params?.ancestorDepth ?? 0;
  const query = resolvePageSnapshotQuery(params?.query);
  if (!['full', 'interactive', 'viewport', 'dom'].includes(mode)) throw new Error('page_snapshot: mode must be one of full, interactive, viewport, dom');
  if (rootSelector !== undefined && (typeof rootSelector !== 'string' || !rootSelector.trim())) throw new Error('page_snapshot: rootSelector must be a non-empty CSS selector');
  if (rootRef !== undefined && (typeof rootRef !== 'string' || !/^@e\d+$/.test(rootRef))) throw new Error('page_snapshot: rootRef must be a snapshot ref like "@e3"');
  if (rootSelector !== undefined && rootRef !== undefined) throw new Error('page_snapshot: rootSelector and rootRef are mutually exclusive');
  if (!Number.isInteger(ancestorDepth) || ancestorDepth < 0 || ancestorDepth > 20) throw new Error('page_snapshot: ancestorDepth must be an integer between 0 and 20');
  if (ancestorDepth > 0 && rootRef === undefined) throw new Error('page_snapshot: ancestorDepth requires rootRef');
  const selectedRoot = rootRef ? browser.resolveSelector(context, rootRef) : rootSelector ?? null;
  const collected = await browser.callInPage<{ tree: FirefoxSnapshotNode | null; error?: string }>(
    context,
    collectPageSnapshot,
    [{ rootSelector: selectedRoot, ancestorDepth: rootRef ? ancestorDepth : 0, depth: typeof params?.depth === 'number' ? params.depth : 0, includeText: mode === 'dom' }],
    deadline,
  );
  if (collected.error) throw new Error(collected.error);
  const refs = new Map<string, FirefoxRef>();
  const visible = new Set<number>();
  const raw = collected.tree ? snapshotNode(collected.tree, refs, visible, { id: 1, ref: 1 }) : null;
  let effectiveMode = mode;
  let filtered = raw;
  if (mode === 'interactive' || mode === 'viewport') {
    filtered = filterSnapshotTree(raw, 'viewport', visible);
    if (mode === 'interactive') {
      if (!hasInteractiveSnapshotNode(filtered)) effectiveMode = 'viewport';
      else filtered = filterSnapshotTree(filtered, 'interactive');
    }
  }
  const queryResult = query ? filterSnapshotTreeByQuery(filtered, query) : { tree: filtered, matches: [] as PageSnapshotQueryMatch[] };
  const limitedMatches = query ? limitPageSnapshotQueryMatches(queryResult.matches) : { matches: [], truncated: false };
  const lines: string[] = [];
  if (queryResult.tree) formatSnapshotNode(queryResult.tree, 0, lines);
  const formatted = formatSnapshotWithLimits(lines.length ? lines : [query ? '(no matches)' : '(empty page)'], {
    maxChars: params?.maxChars,
    maxNodes: params?.maxNodes,
  });
  const output = new Set(Array.from(formatted.snapshot.matchAll(/(?:^|\n)\s*(@e\d+)\s/g), match => match[1]!));
  for (const match of limitedMatches.matches) if (match.ref) output.add(match.ref);
  for (const ref of refs.keys()) if (!output.has(ref)) refs.delete(ref);
  browser.replaceRefs(context, refs);
  const page = params?.includeWebMcp === 'full' ? await browser.pageInfo(context, deadline) : undefined;
  const webmcp = page ? (await refreshFirefoxWebMcp(browser, context, deadline)).fields(page.url, true) : {};
  return {
    ...webmcp,
    snapshot: formatted.snapshot,
    elementCount: countSnapshotNodes(queryResult.tree),
    outputNodeCount: formatted.outputNodeCount,
    mode,
    ...(rootSelector ? { rootSelector } : {}),
    ...(rootRef ? { rootRef, ancestorDepth } : {}),
    ...(query ? { query, matches: limitedMatches.matches, matchCount: queryResult.matches.length, ...(limitedMatches.truncated ? { matchesTruncated: true } : {}) } : {}),
    ...(effectiveMode !== mode ? { fallbackMode: 'viewport' } : {}),
    ...(formatted.truncated ? { truncated: true } : {}),
  };
}

export async function framesFirefoxPage(browser: FirefoxBrowser, context: string, deadline?: number) {
  const result = await browser.connection.send<{ contexts: Array<{ context: string; url: string; children?: unknown[] }> }>(
    'browsingContext.getTree',
    { root: context },
    deadline,
  );
  const frames: Array<{ frameId: string; parentFrameId: string | null; url: string; name: string; isMainFrame: boolean }> = [];
  const walk = (nodes: Array<{ context: string; url: string; children?: unknown[] }> | undefined, parent: string | null, main: boolean) => {
    for (const node of nodes ?? []) {
      frames.push({ frameId: node.context, parentFrameId: parent, url: node.url, name: '', isMainFrame: main });
      walk(node.children as typeof nodes, node.context, false);
    }
  };
  walk(result.contexts, null, true);
  return { frames, count: frames.length };
}

export async function uploadFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const { selector, filePaths } = data as unknown as PageUploadParams;
  if (typeof selector !== 'string' || !selector) throw new PageActionPreconditionError('page_upload: "selector" is required (CSS selector or @eN snapshot ref)');
  checkPageActionPrecondition(() => validatePageElementSelector(selector, 'page_upload'));
  if (!Array.isArray(filePaths) || !filePaths.length || filePaths.some(filePath => typeof filePath !== 'string' || !filePath)) {
    throw new PageActionPreconditionError('Invalid filePaths: must be a non-empty array of file path strings');
  }
  const element = await browser.locate(context, browser.resolveSelector(context, selector), deadline);
  const described = await browser.callInPage<{ tag: string; type: string }>(
    context,
    'function(){return {tag:this.tagName.toLowerCase(),type:this.type||""};}',
    [],
    deadline,
    element,
  );
  if (described.tag !== 'input' || described.type !== 'file') {
    throw new PageActionPreconditionError(`Element <${described.tag || 'unknown'}> is not a file input. selector must point to an <input type="file"> element.`);
  }
  await browser.connection.send('input.setFiles', { context, element, files: filePaths }, deadline);
  return { uploaded: true, fileCount: filePaths.length, tag: described.tag };
}

export async function navigateFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const input = resolvePageNavigateInput(data as unknown as PageNavigateParams);
  browser.clearRefs(context);
  try {
    if (input.mode === 'url') {
      await browser.connection.send('browsingContext.navigate', { context, url: input.url, wait: 'interactive' }, deadline);
    } else if (input.mode === 'refresh') {
      await browser.connection.send('browsingContext.reload', { context, wait: 'interactive' }, deadline);
    } else {
      await browser.connection.send('browsingContext.traverseHistory', { context, delta: input.history === 'back' ? -1 : 1 }, deadline);
    }
  } catch (error) {
    if (input.mode === 'history') {
      throw new Error(`page_navigate: no ${input.history === 'back' ? 'previous' : 'next'} history entry`, { cause: error });
    }
    throw error;
  }
  const page = await browser.pageInfo(context, deadline);
  return {
    success: true,
    url: page.url,
    title: page.title,
    ...(input.mode === 'history' ? { history: input.history } : {}),
    ...(input.mode === 'refresh' ? { refreshed: true } : {}),
  };
}

export async function screenshotFirefoxPage(browser: FirefoxBrowser, context: string, data: JsonObject, deadline?: number) {
  const captureMode = data.captureMode ?? 'visible';
  if (captureMode !== 'visible' && captureMode !== 'cdp') throw new Error('Invalid screenshot captureMode');
  if (captureMode === 'visible' && data.selector !== undefined) {
    throw new Error('Visible capture does not support element selectors');
  }
  const format = data.format ?? 'png';
  if (format !== 'png' && format !== 'jpeg') throw new Error('format must be png or jpeg');
  const quality = typeof data.quality === 'number' ? Math.min(100, Math.max(0, data.quality)) : 80;
  const clip = data.selector === undefined ? undefined : {
    type: 'element',
    element: await browser.locate(context, browser.resolveSelector(context, String(data.selector)), deadline),
  };
  const page = await browser.pageInfo(context, deadline);
  const image = await browser.connection.send<{ data: string }>('browsingContext.captureScreenshot', {
    context,
    origin: captureMode === 'cdp' ? 'document' : 'viewport',
    format: { type: `image/${format}`, ...(format === 'jpeg' ? { quality: quality / 100 } : {}) },
    ...(clip ? { clip } : {}),
  }, deadline);
  return { data: image.data, meta: { format, url: page.url, title: page.title, size: Buffer.byteLength(image.data, 'base64') } };
}
