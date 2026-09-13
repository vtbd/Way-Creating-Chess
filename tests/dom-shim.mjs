/**
 * A deliberately small DOM implementation so `js/app.js` can be exercised in
 * Node without a browser. It supports exactly the API surface the front end
 * uses: elements, text nodes, fragments, classList, dataset, bubbling events,
 * `closest`, `querySelector`, canvas 2D stubs, localStorage and Worker.
 *
 * The page structure is taken from `index.html`, so the ids used by `app.js`
 * are validated against the real markup.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class DomNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined) continue;
      if (node instanceof FragmentNode) {
        this.append(...node.childNodes.slice());
      } else {
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = null;
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export class Node extends DomNode {}

class TextNode extends Node {
  constructor(text) {
    super();
    this.nodeType = 3;
    this._text = String(text);
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }
}

class FragmentNode extends Node {}

class ClassList {
  constructor(element) {
    this.element = element;
  }

  add(...names) {
    for (const name of names) if (name) this.element._classes.add(name);
  }

  remove(...names) {
    for (const name of names) this.element._classes.delete(name);
  }

  toggle(name, force) {
    const has = this.element._classes.has(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.element._classes.add(name);
    else this.element._classes.delete(name);
    return want;
  }

  contains(name) {
    return this.element._classes.has(name);
  }
}

export class Element extends Node {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this._classes = new Set();
    this._listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this._text = null;
    this.value = '';
    this.title = '';
    this.disabled = false;
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.width = 0;
    this.height = 0;
    const element = this;
    this.style = {
      setProperty(name, value) {
        element.style[name] = value;
      },
    };
  }

  get classList() {
    return new ClassList(this);
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this._text !== null) return this._text;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    else if (name === 'id') this.id = String(value);
    // Mirror the content attributes a browser reflects as properties.
    else if (['type', 'value', 'title', 'placeholder', 'min', 'max', 'step', 'name'].includes(name)) {
      this[name] = String(value);
    } else if (name === 'disabled' || name === 'selected' || name === 'checked') {
      this[name] = true;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    list.push(handler);
    this._listeners.set(type, list);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    if (typeof event.preventDefault !== 'function') event.preventDefault = () => {};
    if (typeof event.stopPropagation !== 'function') event.stopPropagation = () => {};
    for (const handler of this._listeners.get(event.type) || []) handler(event);
    if (event.bubbles !== false && this.parentNode && !event._stopped) {
      this.parentNode.dispatchEvent(event);
    }
    return true;
  }

  /** Bubbling helper used by the tests. */
  fire(type, props = {}) {
    const event = { type, bubbles: true, _stopped: false, ...props };
    this.dispatchEvent(event);
    return event;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.childNodes) {
      if (!(child instanceof Element)) continue;
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (!(child instanceof Element)) continue;
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, button: 0 });
  }

  getContext() {
    const noop = () => {};
    return {
      setTransform: noop,
      clearRect: noop,
      fillRect: noop,
      beginPath: noop,
      arc: noop,
      fill: noop,
      fillStyle: '',
    };
  }
}

class DocumentShim extends Element {
  constructor() {
    super('#document');
    this.body = new Element('body');
    this.documentElement = new Element('html');
    this.append(this.body);
  }

  createElement(tag) {
    return new Element(tag);
  }

  createTextNode(text) {
    return new TextNode(text);
  }

  createDocumentFragment() {
    return new FragmentNode();
  }

  querySelector(selector) {
    if (selector.startsWith('#') && this._byId.has(selector.slice(1))) return this._byId.get(selector.slice(1));
    return super.querySelector(selector);
  }
}

/**
 * Build the DOM described by a page (default `index.html`) and install
 * browser globals.
 */
export function installDom(root = process.cwd(), { page = 'index.html', search = '' } = {}) {
  const html = readFileSync(resolve(root, page), 'utf8');
  const document = new DocumentShim();
  document._byId = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = new Element('div');
    element.id = match[1];
    document._byId.set(match[1], element);
    document.body.append(element);
  }

  const storage = new Map();
  const window = {
    devicePixelRatio: 1,
    location: {
      protocol: 'http:',
      origin: 'http://localhost:8000',
      pathname: `/${page}`,
      search,
      href: `http://localhost:8000/${page}${search}`,
    },
    history: {
      replaceState: () => {},
    },
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener: (type, handler) => document.addEventListener(type, handler),
    // The app's AI heartbeat must not keep the Node test process alive.
    setInterval: (handler, ms) => {
      const handle = globalThis.setInterval(handler, ms);
      if (handle && typeof handle.unref === 'function') handle.unref();
      return handle;
    },
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  };

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
    Element: globalThis.Element,
    Worker: globalThis.Worker,
    localStorage: globalThis.localStorage,
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.Node = Node;
  globalThis.Element = Element;
  globalThis.Worker = makeWorkerClass();
  // Browsers expose `localStorage` as a global as well as on `window`.
  globalThis.localStorage = window.localStorage;
  globalThis.__restoreDom = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };

  return { document, window, elements: document._byId, html };
}

/**
 * Worker stub that answers with a legal move for the snapshot it receives, so
 * the whole "send snapshot / apply reply" path is exercised in-process.
 */
export function makeWorkerClass() {
  return class WorkerStub {
    constructor() {
      this._listeners = new Map();
      this.terminated = false;
    }

    addEventListener(type, handler) {
      const list = this._listeners.get(type) || [];
      list.push(handler);
      this._listeners.set(type, list);
    }

    postMessage(message) {
      globalThis.setTimeout(async () => {
        if (this.terminated) return;
        const { GameState, Cell } = await import('../js/engine.js');
        const { RandomAI } = await import('../js/ai.js');
        const state = new GameState(message.board, message.sideToMove);
        const move = new RandomAI().chooseMove(state);
        for (const handler of this._listeners.get('message') || []) {
          handler({
            data: {
              id: message.id,
              move,
              stats: { depth: 1, score: 0, nodes: state.cells.length, elapsedMs: 3 },
            },
          });
        }
      }, 0);
    }

    terminate() {
      this.terminated = true;
    }
  };
}

/** Find the first descendant element whose text matches `text`. */
export function findByText(root, text, tag = '*') {
  const queue = [...root.childNodes];
  while (queue.length) {
    const node = queue.shift();
    if (!(node instanceof Element)) continue;
    const matchesTag = tag === '*' || node.tagName === tag.toUpperCase();
    if (matchesTag && node.textContent.includes(text)) return node;
    queue.push(...node.childNodes);
  }
  return null;
}

export { Cell } from '../js/engine.js';
