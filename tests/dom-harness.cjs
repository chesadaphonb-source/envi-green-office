'use strict';

// Small DOM/RPC test double for client state transitions. This does not render CSS
// or replace an actual browser acceptance test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class EventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this._text = '';
    this.classList = {
      add: (...names) => this.setClasses([...this.classes(), ...names]),
      remove: (...names) => this.setClasses(this.classes().filter(name => !names.includes(name))),
      contains: name => this.classes().includes(name),
      toggle: (name, force) => {
        const enable = force === undefined ? !this.classes().includes(name) : force;
        this.classList[enable ? 'add' : 'remove'](name);
        return enable;
      }
    };
  }
  classes() { return this.className.split(/\s+/).filter(Boolean); }
  setClasses(names) { this.className = [...new Set(names)].join(' '); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  set innerHTML(value) { throw new Error('Unsafe HTML write in client test: ' + value); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...children) {
    children.forEach(child => this.appendChild(typeof child === 'string' ? Object.assign(new Element('text'), { textContent: child }) : child));
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  removeChild(child) { this.children = this.children.filter(item => item !== child); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  scrollIntoView() {}
  click() { if (!this.disabled) this.dispatch('click'); }
  querySelectorAll(selector) {
    return descendants(this).filter(element => selector.startsWith('.')
      ? element.classes().includes(selector.slice(1))
      : element.tagName === selector.toUpperCase());
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function createClient(options = {}) {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.id = match[3];
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(element.id, element);
  }
  const document = new EventTarget();
  Object.assign(document, {
    readyState: 'loading',
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    createTextNode: value => Object.assign(new Element('text'), { textContent: value }),
    body: new Element('body'),
    documentElement: new Element('html'),
    querySelectorAll: selector => [...elements.values()].flatMap(element => element.querySelectorAll(selector))
  });
  document.body.setAttribute('data-app-url', 'https://script.google.com/macros/s/test-deployment/exec');
  document.body.setAttribute('data-initial-route', JSON.stringify(options.parameters || {}));
  const window = new EventTarget();
  const requests = [];
  let hash = '';
  const location = { pathname: '/', search: '', origin: 'http://localhost', href: 'http://localhost/' };
  Object.defineProperty(location, 'hash', {
    get: () => hash,
    set: value => {
      if (hash === value) return;
      hash = value;
      queueMicrotask(() => window.dispatch('hashchange'));
    }
  });
  const history = {
    replaceState(state, title, url) { if (typeof url === 'string' && url.includes('#')) hash = url.slice(url.indexOf('#')); },
    pushState(state, title, url) { if (typeof url === 'string' && url.includes('#')) hash = url.slice(url.indexOf('#')); }
  };
  function runner(success, failure) {
    const target = {
      withSuccessHandler(handler) { return runner(handler, failure); },
      withFailureHandler(handler) { return runner(success, handler); }
    };
    for (const method of ['getDashboardData', 'getFolderContents', 'searchDrive', 'getFileDetails']) {
      target[method] = (...args) => { requests.push({ method, args, success, failure }); };
    }
    return target;
  }
  let historyHandler;
  let initialLocationCallback;
  const entries = [{ parameter: { ...options.parameters } }];
  let historyIndex = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const google = { script: { run: runner(),
    history: {
      push(state, params) { entries.splice(historyIndex + 1); entries.push({ parameter: copy(params) }); historyIndex++; },
      replace(state, params) { entries[historyIndex] = { parameter: copy(params) }; },
      setChangeHandler(handler) { historyHandler = handler; }
    },
    url: { getLocation(callback) { if (options.deferLocation) initialLocationCallback = callback; else callback(copy(entries[historyIndex])); } }
  } };
  const clipboardWrites = [];
  Object.assign(window, { location, history, google, scrollTo() {} });
  const context = vm.createContext({
    document, window, location, history, google, URL, URLSearchParams, Intl,
    console, setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
    navigator: { language: 'th-TH', clipboard: { async writeText(value) {
      if (options.clipboardError) throw new Error('Clipboard unavailable');
      clipboardWrites.push(value);
    } } }
  });
  const script = fs.readFileSync(path.join(root, 'js.html'), 'utf8').replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  vm.runInContext(script, context, { filename: 'js.html' });
  document.dispatch('DOMContentLoaded');
  return {
    elements, requests, window, document, context, clipboardWrites,
    route: () => copy(entries[historyIndex].parameter),
    get historyLength() { return entries.length; },
    back() { if (historyIndex > 0) historyHandler({ location: copy(entries[--historyIndex]) }); },
    forward() { if (historyIndex + 1 < entries.length) historyHandler({ location: copy(entries[++historyIndex]) }); },
    finishLocation() { initialLocationCallback(copy(entries[historyIndex])); },
    element: id => elements.get(id),
    find: (id, predicate) => descendants(elements.get(id)).find(predicate),
    all: id => descendants(elements.get(id)),
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    next(method) {
      const index = requests.findIndex(request => request.method === method);
      if (index < 0) throw new Error('No pending RPC: ' + method + '; pending: ' + requests.map(request => request.method).join(', '));
      return requests.splice(index, 1)[0];
    }
  };
}

module.exports = { createClient, Element };
