/**
 * In-page collectors. They are serialized with toString() and must not close over module scope.
 */

export interface FirefoxSnapshotNode {
  role: string;
  name: string;
  selector: string;
  value?: string;
  focused?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  inViewport: boolean;
  children?: FirefoxSnapshotNode[];
}

export function collectPageSnapshot(options: {
  rootSelector: string | null;
  ancestorDepth: number;
  depth: number;
  includeText: boolean;
}): { tree: FirefoxSnapshotNode | null; error?: string } {
  const maxNodes = 2000;
  let count = 0;
  const rootSelector = options && options.rootSelector;
  const ancestorDepth = options && options.ancestorDepth ? options.ancestorDepth : 0;
  const maxDepth = options && options.depth > 0 ? options.depth : 30;
  const includeText = Boolean(options && options.includeText);

  function cssPath(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id));
        break;
      }
      let part = tag;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(child => child.tagName === node!.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0] || '';
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const html = element as HTMLInputElement;
      const type = (html.type || 'text').toLowerCase();
      if (type === 'hidden' || type === 'file') return type === 'file' ? 'button' : '';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if ((element as HTMLElement).isContentEditable) return 'textbox';
    return '';
  }

  function nameOf(element: Element, role: string): string {
    const labelled = element.getAttribute('aria-label');
    if (labelled && labelled.trim()) return labelled.trim().slice(0, 200);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ');
      if (text) return text.slice(0, 200);
    }
    const html = element as HTMLImageElement & HTMLInputElement;
    if (html.alt) return String(html.alt).trim().slice(0, 200);
    const labels = (html as HTMLInputElement).labels;
    if (labels && labels[0]) {
      const text = (labels[0].innerText || labels[0].textContent || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 200);
    }
    if (html.placeholder) return String(html.placeholder).trim().slice(0, 200);
    if (!role && !includeText) return '';
    const text = (element as HTMLElement).innerText || element.textContent || '';
    return text.trim().replace(/\s+/g, ' ').slice(0, 200);
  }

  function visible(element: Element): boolean {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function visit(element: Element, depth: number): FirefoxSnapshotNode | null {
    if (count >= maxNodes || depth > maxDepth) return null;
    const tag = element.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'noscript', 'template', 'head'].includes(tag)) return null;
    if (element.getAttribute('aria-hidden') === 'true') return null;
    const role = roleOf(element);
    const name = nameOf(element, role);
    const children: FirefoxSnapshotNode[] = [];
    const nested = element.shadowRoot ? Array.from(element.shadowRoot.children) : [];
    for (const child of [...Array.from(element.children), ...nested]) {
      const visited = visit(child, depth + 1);
      if (visited) children.push(visited);
    }
    const keep = Boolean(role) || (includeText && Boolean(name)) || children.length > 0;
    if (!keep) return null;
    count += 1;
    const html = element as HTMLInputElement;
    const checked = html.indeterminate ? 'mixed' : html.checked === true || html.checked === false ? html.checked : undefined;
    const expanded = element.getAttribute('aria-expanded');
    const node: FirefoxSnapshotNode = {
      role: role || (name ? 'StaticText' : 'generic'),
      name,
      selector: cssPath(element),
      inViewport: visible(element),
      ...(html.value && (role === 'textbox' || role === 'searchbox' || role === 'combobox') ? { value: String(html.value).slice(0, 200) } : {}),
      ...(document.activeElement === element ? { focused: true } : {}),
      ...(checked !== undefined && (role === 'checkbox' || role === 'radio' || role === 'switch') ? { checked } : {}),
      ...(html.disabled ? { disabled: true } : {}),
      ...(expanded === 'true' || expanded === 'false' ? { expanded: expanded === 'true' } : {}),
      ...(element.getAttribute('aria-selected') === 'true' ? { selected: true } : {}),
      ...(children.length ? { children } : {}),
    };
    return node;
  }

  let root: Element | null = document.body || document.documentElement;
  if (rootSelector) {
    try {
      root = document.querySelector(rootSelector);
    } catch (error) {
      return { tree: null, error: 'Invalid CSS selector "' + rootSelector + '": ' + (error as Error).message };
    }
    if (!root) return { tree: null, error: 'page_snapshot: root element not found: ' + rootSelector };
    let remaining = ancestorDepth;
    while (root.parentElement && remaining > 0) {
      root = root.parentElement;
      remaining -= 1;
    }
  }
  const tree = root ? visit(root, 0) : null;
  return {
    tree: tree
      ? { role: 'RootWebArea', name: document.title || '', selector: '', inViewport: true, ...(tree ? { children: [tree] } : {}) }
      : { role: 'RootWebArea', name: document.title || '', selector: '', inViewport: true },
  };
}

export function collectNamedElements(scopeSelector: string | null): { nodes?: Array<{ selector: string; role: string; name: string }>; error?: string } {
  let scope: ParentNode = document;
  if (scopeSelector) {
    let root: Element | null;
    try {
      root = document.querySelector(scopeSelector);
    } catch (error) {
      return { error: 'Invalid CSS selector "' + scopeSelector + '": ' + (error as Error).message };
    }
    if (!root) return { error: 'page_click: scope "' + scopeSelector + '" was not found' };
    scope = root;
  }
  const nodes: Array<{ selector: string; role: string; name: string }> = [];
  const elements = scope.querySelectorAll('a,button,input,textarea,select,summary,[role],[contenteditable="true"]');
  for (const element of Array.from(elements)) {
    if (nodes.length >= 2000) break;
    const role = element.getAttribute('role') || element.tagName.toLowerCase();
    const name = (
      element.getAttribute('aria-label') ||
      (element as HTMLElement).innerText ||
      element.textContent ||
      (element as HTMLInputElement).value ||
      ''
    ).trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!name) continue;
    const tag = element.tagName.toLowerCase();
    let normalized = role;
    if (!element.getAttribute('role')) {
      if (tag === 'a') normalized = 'link';
      else if (tag === 'button' || tag === 'summary') normalized = 'button';
      else if (tag === 'textarea') normalized = 'textbox';
      else if (tag === 'select') normalized = 'combobox';
      else if (tag === 'input') {
        const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
        normalized = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : type === 'button' || type === 'submit' ? 'button' : 'textbox';
      }
    }
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent: HTMLElement | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    nodes.push({ selector: parts.join(' > '), role: normalized, name });
  }
  return { nodes };
}
