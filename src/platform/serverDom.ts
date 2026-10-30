// ============================================================================
// SERVER DOM — a minimal DOM for rendering without happy-dom / jsdom
// ============================================================================
//
// Tag factories build live nodes, so a server render needs *a* DOM. A full
// emulation (jsdom, happy-dom) implements layout, CSSOM, an HTML parser and a
// window; a server render uses none of that. This module implements only what
// the SibuJS runtime and its serializer touch:
//
//   - Node / Element / HTMLElement / SVGElement / Text / Comment /
//     DocumentFragment / Document, with the namespaces of SVG and MathML;
//   - attributes (+ NS variants), `classList`, `dataset`, `style` as a
//     declaration map serialized the way browsers serialize it;
//   - child mutation, `textContent`, sibling links, `contains`,
//     `compareDocumentPosition`, a small selector engine;
//   - the form-control IDL semantics the attribute writer relies on (`checked`,
//     `value`, `selected` are properties that do not reflect; `disabled` does),
//     so output matches jsdom byte for byte;
//   - events with bubbling and `preventDefault` (ErrorBoundary claims errors
//     through one), `MutationObserver` (Suspense), a `TreeWalker`;
//   - no-ops for layout (`getBoundingClientRect` is all zeros, `focus()` does
//     nothing).
//
// Browser-only APIs a component might call while rendering — canvas
// contexts, `document.fonts`, `animate()`, `showModal()` — do not silently run
// against an emulation: they throw (or, for probes such as `getContext`, warn
// and answer "unavailable"), naming the API and the calling source location.
//
// There is deliberately no `window`: `typeof window === "undefined"` keeps
// meaning "not in a browser" for application guards.

import { DEV } from "../core/dev";
import { requestSlot } from "../core/ssr-context";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

// ─── Diagnostics ────────────────────────────────────────────────────────────

/** The first stack frame outside this module: where application code called in. */
function callerFrame(): string {
  const stack = new Error().stack ?? "";
  const lines = stack.split("\n").slice(1);
  for (const line of lines) {
    if (line.includes("serverDom")) continue;
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/^at\s+/, "");
  }
  return "(unknown caller)";
}

/** Record a browser-only API read for the current render's diagnostics, and warn once per site in dev. */
const warnedSites = new Set<string>();
export function reportBrowserApi(api: string): string {
  const frame = callerFrame();
  const entry = `${api} at ${frame}`;
  requestSlot("browserApis", () => new Set<string>())?.add(entry);
  if (DEV && !warnedSites.has(entry) && warnedSites.size < 200) {
    warnedSites.add(entry);
    console.warn(
      `[SibuJS SSR] ${api} was used during a server render (${frame}). It only exists in a browser: ` +
        "move the code into onMount() or an effect, or render it with ClientOnly().",
    );
  }
  return frame;
}

/** Throw the error a browser-only API raises in the server DOM. */
function unavailable(api: string): never {
  const frame = reportBrowserApi(api);
  throw new Error(
    `[SibuJS SSR] ${api} is not available in the SibuJS server DOM (called from ${frame}). ` +
      "It needs a browser: call it from onMount() or an effect, or render the component with ClientOnly().",
  );
}

function invalidCharacter(name: string): never {
  const Ctor = (globalThis as { DOMException?: new (message: string, name: string) => Error }).DOMException;
  const message = `"${name}" did not match the Name production`;
  throw Ctor ? new Ctor(message, "InvalidCharacterError") : new Error(message);
}

const NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_.:·À-￿]*$/;

// ─── Live lists ─────────────────────────────────────────────────────────────

/** `NodeList`-shaped array: index access, `length`, `item()`, iteration. */
class ServerNodeList<T> extends Array<T> {
  static get [Symbol.species]() {
    return Array;
  }
  item(index: number): T | null {
    return this[index] ?? null;
  }
}

// ─── Events ─────────────────────────────────────────────────────────────────

type Listener = { fn: EventListenerOrEventListenerObject; capture: boolean; once: boolean };

interface DispatchableEvent {
  type: string;
  bubbles: boolean;
  defaultPrevented: boolean;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

// ─── Mutation observers ─────────────────────────────────────────────────────

interface Observation {
  observer: ServerMutationObserver;
  target: ServerNode;
  options: MutationObserverInit;
}

const observations: Observation[] = [];

interface ServerMutationRecord {
  type: "childList" | "attributes" | "characterData";
  target: ServerNode;
  addedNodes: ServerNode[];
  removedNodes: ServerNode[];
  previousSibling: ServerNode | null;
  nextSibling: ServerNode | null;
  attributeName: string | null;
  attributeNamespace: string | null;
  oldValue: string | null;
}

function queueRecord(record: ServerMutationRecord): void {
  if (observations.length === 0) return;
  for (const obs of observations) {
    const o = obs.options;
    const wants =
      record.type === "childList" ? o.childList : record.type === "attributes" ? o.attributes : o.characterData;
    if (!wants) continue;
    if (obs.target !== record.target && !(o.subtree && obs.target.contains(record.target))) continue;
    obs.observer._enqueue(record);
  }
}

class ServerMutationObserver {
  private records: ServerMutationRecord[] = [];
  private scheduled = false;
  constructor(private readonly callback: (records: ServerMutationRecord[], observer: ServerMutationObserver) => void) {}
  observe(target: ServerNode, options: MutationObserverInit = {}): void {
    const opts: MutationObserverInit = { ...options };
    if (opts.attributeFilter || opts.attributeOldValue) opts.attributes ??= true;
    if (opts.characterDataOldValue) opts.characterData ??= true;
    const existing = observations.find((o) => o.observer === this && o.target === target);
    if (existing) existing.options = opts;
    else observations.push({ observer: this, target, options: opts });
  }
  disconnect(): void {
    for (let i = observations.length - 1; i >= 0; i--) if (observations[i].observer === this) observations.splice(i, 1);
    this.records = [];
  }
  takeRecords(): ServerMutationRecord[] {
    const out = this.records;
    this.records = [];
    return out;
  }
  /** @internal */
  _enqueue(record: ServerMutationRecord): void {
    this.records.push(record);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const records = this.takeRecords();
      if (records.length > 0) this.callback(records, this);
    });
  }
}

// ─── Node ───────────────────────────────────────────────────────────────────

export class ServerNode {
  static readonly ELEMENT_NODE = ELEMENT_NODE;
  static readonly ATTRIBUTE_NODE = ATTRIBUTE_NODE;
  static readonly TEXT_NODE = TEXT_NODE;
  static readonly COMMENT_NODE = COMMENT_NODE;
  static readonly DOCUMENT_NODE = DOCUMENT_NODE;
  static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
  static readonly DOCUMENT_POSITION_DISCONNECTED = 1;
  static readonly DOCUMENT_POSITION_PRECEDING = 2;
  static readonly DOCUMENT_POSITION_FOLLOWING = 4;
  static readonly DOCUMENT_POSITION_CONTAINS = 8;
  static readonly DOCUMENT_POSITION_CONTAINED_BY = 16;

  /** @internal */ _parent: ServerNode | null = null;
  /** @internal */ _prev: ServerNode | null = null;
  /** @internal */ _next: ServerNode | null = null;
  /** @internal */ _first: ServerNode | null = null;
  /** @internal */ _last: ServerNode | null = null;
  /** @internal */ _count = 0;
  /** @internal */ _list: ServerNodeList<ServerNode> | null = null;
  /** @internal */ _listeners: Map<string, Listener[]> | null = null;

  constructor(readonly ownerDocument: ServerDocument | null) {}

  get nodeType(): number {
    return 0;
  }
  get nodeName(): string {
    return "";
  }
  get nodeValue(): string | null {
    return null;
  }
  set nodeValue(_value: string | null) {}

  get parentNode(): ServerNode | null {
    return this._parent;
  }
  get parentElement(): ServerElement | null {
    return this._parent instanceof ServerElement ? this._parent : null;
  }
  get firstChild(): ServerNode | null {
    return this._first;
  }
  get lastChild(): ServerNode | null {
    return this._last;
  }
  get nextSibling(): ServerNode | null {
    return this._next;
  }
  get previousSibling(): ServerNode | null {
    return this._prev;
  }
  get childNodes(): ServerNodeList<ServerNode> {
    if (!this._list) {
      const list = new ServerNodeList<ServerNode>();
      for (let n = this._first; n; n = n._next) list.push(n);
      this._list = list;
    }
    return this._list;
  }
  hasChildNodes(): boolean {
    return this._first !== null;
  }
  get isConnected(): boolean {
    let n: ServerNode | null = this;
    while (n) {
      if (n.nodeType === DOCUMENT_NODE) return true;
      n = n._parent;
    }
    return false;
  }
  getRootNode(): ServerNode {
    let n: ServerNode = this;
    while (n._parent) n = n._parent;
    return n;
  }

  get textContent(): string | null {
    let out = "";
    for (let n = this._first; n; n = n._next) {
      if (n.nodeType === TEXT_NODE) out += (n as ServerCharacterData).data;
      else if (n.nodeType === ELEMENT_NODE || n.nodeType === DOCUMENT_FRAGMENT_NODE) out += n.textContent ?? "";
    }
    return out;
  }
  set textContent(value: string | null) {
    while (this._first) this.removeChild(this._first);
    const text = value == null ? "" : String(value);
    if (text !== "") this.appendChild(new ServerText(this.ownerDocument, text));
  }

  contains(other: ServerNode | null): boolean {
    for (let n = other; n; n = n._parent) if (n === this) return true;
    return false;
  }

  compareDocumentPosition(other: ServerNode): number {
    if (other === this) return 0;
    if (this.getRootNode() !== other.getRootNode()) return 1 | 32;
    if (this.contains(other)) return 16 | 4;
    if (other.contains(this)) return 8 | 2;
    // Walk the ancestors to the children of their common ancestor.
    const chain = (n: ServerNode) => {
      const out: ServerNode[] = [];
      for (let c: ServerNode | null = n; c; c = c._parent) out.unshift(c);
      return out;
    };
    const a = chain(this);
    const b = chain(other);
    let i = 0;
    while (a[i] === b[i]) i++;
    for (let n = a[i]._next; n; n = n._next) if (n === b[i]) return 4;
    return 2;
  }

  // ── Mutation ──
  /** @internal */
  _assertParentOf(node: ServerNode): void {
    if (!(node instanceof ServerNode))
      throw new TypeError("Failed to execute on Node: parameter is not of type 'Node'.");
    if (node.contains(this)) {
      const Ctor = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
      const message = "The new child element contains the parent.";
      throw Ctor ? new Ctor(message, "HierarchyRequestError") : new Error(message);
    }
  }

  insertBefore<T extends ServerNode>(node: T, ref: ServerNode | null): T {
    if (ref && ref._parent !== this) {
      const Ctor = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
      const message = "The node before which the new node is to be inserted is not a child of this node.";
      throw Ctor ? new Ctor(message, "NotFoundError") : new Error(message);
    }
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      const moved: ServerNode[] = [];
      while (node._first) {
        const child = node._first;
        node._unlink(child, true);
        moved.push(child);
      }
      for (const child of moved) this._link(child, ref, true);
      if (moved.length > 0) this._recordChildList(moved, [], moved[0]._prev, ref);
      return node;
    }
    this._assertParentOf(node);
    if (ref === node) ref = node._next;
    if (node._parent) node._parent.removeChild(node);
    this._link(node, ref, false);
    this._recordChildList([node], [], node._prev, node._next);
    return node;
  }

  appendChild<T extends ServerNode>(node: T): T {
    return this.insertBefore(node, null);
  }

  removeChild<T extends ServerNode>(node: T): T {
    if (node._parent !== this) {
      const Ctor = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
      const message = "The node to be removed is not a child of this node.";
      throw Ctor ? new Ctor(message, "NotFoundError") : new Error(message);
    }
    const prev = node._prev;
    const next = node._next;
    this._unlink(node, false);
    this._recordChildList([], [node], prev, next);
    return node;
  }

  replaceChild<T extends ServerNode>(node: ServerNode, old: T): T {
    if (node === old) return old;
    const next = old._next === node ? node._next : old._next;
    this.removeChild(old);
    this.insertBefore(node, next);
    return old;
  }

  /** @internal */
  _link(node: ServerNode, ref: ServerNode | null, quiet: boolean): void {
    node._parent = this;
    if (ref) {
      node._prev = ref._prev;
      node._next = ref;
      if (ref._prev) ref._prev._next = node;
      else this._first = node;
      ref._prev = node;
    } else {
      node._prev = this._last;
      node._next = null;
      if (this._last) this._last._next = node;
      else this._first = node;
      this._last = node;
    }
    this._count++;
    this._list = null;
    void quiet;
  }

  /** @internal */
  _unlink(node: ServerNode, quiet: boolean): void {
    if (node._prev) node._prev._next = node._next;
    else this._first = node._next;
    if (node._next) node._next._prev = node._prev;
    else this._last = node._prev;
    node._parent = null;
    node._prev = null;
    node._next = null;
    this._count--;
    this._list = null;
    void quiet;
  }

  /** @internal */
  _recordChildList(added: ServerNode[], removed: ServerNode[], prev: ServerNode | null, next: ServerNode | null): void {
    if (observations.length === 0) return;
    queueRecord({
      type: "childList",
      target: this,
      addedNodes: added,
      removedNodes: removed,
      previousSibling: prev,
      nextSibling: next,
      attributeName: null,
      attributeNamespace: null,
      oldValue: null,
    });
  }

  // ── ChildNode / ParentNode ──
  remove(): void {
    this._parent?.removeChild(this);
  }
  replaceWith(...nodes: Array<ServerNode | string>): void {
    const parent = this._parent;
    if (!parent) return;
    const next = this._next;
    parent.removeChild(this);
    for (const n of nodes) parent.insertBefore(toNode(this.ownerDocument, n), next);
  }
  before(...nodes: Array<ServerNode | string>): void {
    const parent = this._parent;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(toNode(this.ownerDocument, n), this);
  }
  after(...nodes: Array<ServerNode | string>): void {
    const parent = this._parent;
    if (!parent) return;
    const next = this._next;
    for (const n of nodes) parent.insertBefore(toNode(this.ownerDocument, n), next);
  }
  append(...nodes: Array<ServerNode | string>): void {
    for (const n of nodes) this.appendChild(toNode(this.ownerDocument, n));
  }
  prepend(...nodes: Array<ServerNode | string>): void {
    const first = this._first;
    for (const n of nodes) this.insertBefore(toNode(this.ownerDocument, n), first);
  }
  replaceChildren(...nodes: Array<ServerNode | string>): void {
    while (this._first) this.removeChild(this._first);
    this.append(...nodes);
  }

  get children(): ServerNodeList<ServerElement> {
    const list = new ServerNodeList<ServerElement>();
    for (let n = this._first; n; n = n._next) if (n.nodeType === ELEMENT_NODE) list.push(n as ServerElement);
    return list;
  }
  get childElementCount(): number {
    let c = 0;
    for (let n = this._first; n; n = n._next) if (n.nodeType === ELEMENT_NODE) c++;
    return c;
  }
  get firstElementChild(): ServerElement | null {
    for (let n = this._first; n; n = n._next) if (n.nodeType === ELEMENT_NODE) return n as ServerElement;
    return null;
  }
  get lastElementChild(): ServerElement | null {
    for (let n = this._last; n; n = n._prev) if (n.nodeType === ELEMENT_NODE) return n as ServerElement;
    return null;
  }
  get nextElementSibling(): ServerElement | null {
    for (let n = this._next; n; n = n._next) if (n.nodeType === ELEMENT_NODE) return n as ServerElement;
    return null;
  }
  get previousElementSibling(): ServerElement | null {
    for (let n = this._prev; n; n = n._prev) if (n.nodeType === ELEMENT_NODE) return n as ServerElement;
    return null;
  }

  querySelector(selector: string): ServerElement | null {
    const sel = compileSelector(selector);
    let found: ServerElement | null = null;
    walkElements(this, (el) => {
      if (matchesCompiled(el, sel, this)) {
        found = el;
        return true;
      }
      return false;
    });
    return found;
  }
  querySelectorAll(selector: string): ServerNodeList<ServerElement> {
    const sel = compileSelector(selector);
    const out = new ServerNodeList<ServerElement>();
    walkElements(this, (el) => {
      if (matchesCompiled(el, sel, this)) out.push(el);
      return false;
    });
    return out;
  }
  getElementsByTagName(name: string): ServerNodeList<ServerElement> {
    return this.querySelectorAll(name === "*" ? "*" : name);
  }
  getElementsByClassName(names: string): ServerNodeList<ServerElement> {
    const selector = names
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => `.${n}`)
      .join("");
    return selector ? this.querySelectorAll(selector) : new ServerNodeList();
  }

  cloneNode(deep = false): ServerNode {
    const copy = this._shallowClone();
    if (deep) for (let n = this._first; n; n = n._next) copy.appendChild(n.cloneNode(true));
    return copy;
  }
  /** @internal */
  _shallowClone(): ServerNode {
    return new ServerNode(this.ownerDocument);
  }
  isEqualNode(other: ServerNode | null): boolean {
    return !!other && serializeForDebug(this) === serializeForDebug(other);
  }
  isSameNode(other: ServerNode | null): boolean {
    return other === this;
  }
  normalize(): void {
    for (let n = this._first; n; ) {
      const next = n._next;
      if (n.nodeType === TEXT_NODE) {
        const text = n as ServerText;
        if (text.data === "") this.removeChild(n);
        else
          while (text._next && text._next.nodeType === TEXT_NODE) {
            text.data += (text._next as ServerText).data;
            this.removeChild(text._next);
          }
      } else n.normalize();
      n = n._parent === this ? n._next : next;
    }
  }

  // ── EventTarget ──
  addEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!fn) return;
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const once = typeof options === "object" && !!options?.once;
    const map = (this._listeners ??= new Map<string, Listener[]>());
    const list = map.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    map.set(type, list);
    const signal = typeof options === "object" ? options?.signal : undefined;
    signal?.addEventListener("abort", () => this.removeEventListener(type, fn, options), { once: true });
  }
  removeEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    const list = this._listeners?.get(type);
    if (!list || !fn) return;
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i !== -1) list.splice(i, 1);
  }
  dispatchEvent(event: Event): boolean {
    const ev = event as unknown as DispatchableEvent;
    let stopped = false;
    let stoppedNow = false;
    const ownStop = ev.stopPropagation.bind(ev);
    const ownStopNow = ev.stopImmediatePropagation.bind(ev);
    defineOwn(ev, "stopPropagation", () => {
      stopped = true;
      ownStop();
    });
    defineOwn(ev, "stopImmediatePropagation", () => {
      stopped = true;
      stoppedNow = true;
      ownStopNow();
    });
    defineOwn(ev, "target", this);
    const path: ServerNode[] = [];
    for (let n: ServerNode | null = this; n; n = n._parent) path.push(n);
    const phase = (node: ServerNode, capture: boolean | null) => {
      const list = node._listeners?.get(ev.type);
      if (!list) return;
      defineOwn(ev, "currentTarget", node);
      for (const l of list.slice()) {
        if (capture !== null && l.capture !== capture) continue;
        if (l.once) node.removeEventListener(ev.type, l.fn, l.capture);
        if (typeof l.fn === "function") l.fn.call(node, event);
        else l.fn.handleEvent(event);
        if (stoppedNow) return;
      }
    };
    for (let i = path.length - 1; i > 0 && !stopped; i--) phase(path[i], true);
    if (!stopped) phase(this, null);
    if (ev.bubbles) for (let i = 1; i < path.length && !stopped; i++) phase(path[i], false);
    defineOwn(ev, "currentTarget", null);
    return !ev.defaultPrevented;
  }
}

function defineOwn(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
}

function toNode(doc: ServerDocument | null, n: ServerNode | string): ServerNode {
  return typeof n === "string" ? new ServerText(doc, n) : n;
}

/** Pre-order walk of the elements below `root`; `visit` returns true to stop. */
function walkElements(root: ServerNode, visit: (el: ServerElement) => boolean): boolean {
  for (let n = root._first; n; n = n._next) {
    if (n.nodeType === ELEMENT_NODE) {
      if (visit(n as ServerElement)) return true;
      if (walkElements(n, visit)) return true;
    } else if (n.nodeType === DOCUMENT_FRAGMENT_NODE && walkElements(n, visit)) return true;
  }
  return false;
}

// ─── CharacterData ──────────────────────────────────────────────────────────

class ServerCharacterData extends ServerNode {
  /** @internal */ _data: string;
  constructor(doc: ServerDocument | null, data: string) {
    super(doc);
    this._data = data;
  }
  get data(): string {
    return this._data;
  }
  set data(value: string) {
    const old = this._data;
    this._data = value == null ? "" : String(value);
    if (observations.length > 0) {
      queueRecord({
        type: "characterData",
        target: this,
        addedNodes: [],
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
        attributeName: null,
        attributeNamespace: null,
        oldValue: old,
      });
    }
  }
  get length(): number {
    return this._data.length;
  }
  override get nodeValue(): string {
    return this._data;
  }
  override set nodeValue(value: string | null) {
    this.data = value ?? "";
  }
  override get textContent(): string {
    return this._data;
  }
  override set textContent(value: string | null) {
    this.data = value ?? "";
  }
  override appendChild<T extends ServerNode>(_node: T): T {
    throw new TypeError("This node type does not support this method.");
  }
  override insertBefore<T extends ServerNode>(_node: T, _ref: ServerNode | null): T {
    throw new TypeError("This node type does not support this method.");
  }
}

export class ServerText extends ServerCharacterData {
  override get nodeType(): number {
    return TEXT_NODE;
  }
  override get nodeName(): string {
    return "#text";
  }
  get wholeText(): string {
    return this._data;
  }
  splitText(offset: number): ServerText {
    const rest = new ServerText(this.ownerDocument, this._data.slice(offset));
    this.data = this._data.slice(0, offset);
    this._parent?.insertBefore(rest, this._next);
    return rest;
  }
  override _shallowClone(): ServerNode {
    return new ServerText(this.ownerDocument, this._data);
  }
}

export class ServerComment extends ServerCharacterData {
  override get nodeType(): number {
    return COMMENT_NODE;
  }
  override get nodeName(): string {
    return "#comment";
  }
  override _shallowClone(): ServerNode {
    return new ServerComment(this.ownerDocument, this._data);
  }
}

export class ServerDocumentFragment extends ServerNode {
  override get nodeType(): number {
    return DOCUMENT_FRAGMENT_NODE;
  }
  override get nodeName(): string {
    return "#document-fragment";
  }
  getElementById(id: string): ServerElement | null {
    return this.querySelector(`#${cssEscapeIdent(id)}`);
  }
  override _shallowClone(): ServerNode {
    return new ServerDocumentFragment(this.ownerDocument);
  }
}

// ─── Attributes ─────────────────────────────────────────────────────────────

export class ServerAttr {
  readonly nodeType = ATTRIBUTE_NODE;
  readonly specified = true;
  /** @internal */ _value: string;
  constructor(
    readonly ownerElement: ServerElement | null,
    readonly namespaceURI: string | null,
    readonly prefix: string | null,
    readonly localName: string,
    value: string,
  ) {
    this._value = value;
  }
  get name(): string {
    return this.prefix ? `${this.prefix}:${this.localName}` : this.localName;
  }
  get nodeName(): string {
    return this.name;
  }
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    if (this.ownerElement) this.ownerElement.setAttributeNS(this.namespaceURI, this.name, v);
    else this._value = String(v);
  }
  get nodeValue(): string {
    return this._value;
  }
  get textContent(): string {
    return this._value;
  }
}

class ServerNamedNodeMap extends Array<ServerAttr> {
  static get [Symbol.species]() {
    return Array;
  }
  item(index: number): ServerAttr | null {
    return this[index] ?? null;
  }
  getNamedItem(name: string): ServerAttr | null {
    return this.find((a) => a.name === name) ?? null;
  }
  getNamedItemNS(ns: string | null, localName: string): ServerAttr | null {
    return this.find((a) => a.namespaceURI === (ns || null) && a.localName === localName) ?? null;
  }
}

// ─── Style ──────────────────────────────────────────────────────────────────

/** Split a declaration list on `;` outside parentheses and quotes. */
function splitDeclarations(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

const CAMEL_EXCEPTIONS: Record<string, string> = { cssFloat: "float" };

function toKebab(prop: string): string {
  if (prop.startsWith("--")) return prop;
  if (Object.hasOwn(CAMEL_EXCEPTIONS, prop)) return CAMEL_EXCEPTIONS[prop];
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, "-$1-");
}

/**
 * `CSSStyleDeclaration` as a declaration map. Values are kept as written
 * (trimmed), not normalized: a full CSSOM rewrites some values (jsdom turns
 * `#fff` into `rgb(255, 255, 255)`), this one does not. Serialized the way
 * browsers serialize `style`: `prop: value;` joined by spaces.
 */
export class ServerStyle {
  /** @internal */ _decls = new Map<string, { value: string; priority: string }>();
  /** @internal */ _parsedFrom: string | null = null;
  constructor(private readonly el: ServerElement) {}
  /** @internal */
  _sync(): void {
    const attr = this.el.getAttribute("style");
    if (attr === this._parsedFrom) return;
    this._decls = new Map();
    this._parsedFrom = attr;
    if (!attr) return;
    for (const decl of splitDeclarations(attr)) {
      const colon = decl.indexOf(":");
      if (colon === -1) continue;
      const name = decl.slice(0, colon).trim();
      let value = decl.slice(colon + 1).trim();
      if (!name || !value) continue;
      let priority = "";
      // `value` is trimmed, so `!important` can only END it. Found from the
      // last `!` rather than with a leading `\s*` regex, whose backtracking is
      // quadratic in a long run of spaces (a style value from user input).
      const bang = value.lastIndexOf("!");
      if (bang !== -1 && /^!\s*important$/i.test(value.slice(bang))) {
        priority = "important";
        value = value.slice(0, bang).trim();
      }
      this._decls.set(name.startsWith("--") ? name : name.toLowerCase(), { value, priority });
    }
  }
  /** @internal */
  _commit(): void {
    const text = this.cssText;
    this._parsedFrom = text === "" ? null : text;
    if (text === "") this.el.removeAttribute("style");
    else this.el.setAttribute("style", text);
    this._parsedFrom = this.el.getAttribute("style");
  }
  get cssText(): string {
    this._sync();
    const parts: string[] = [];
    for (const [name, d] of this._decls) parts.push(`${name}: ${d.value}${d.priority ? " !important" : ""};`);
    return parts.join(" ");
  }
  set cssText(text: string) {
    this.el.setAttribute("style", String(text ?? ""));
    this._sync();
    if (this._decls.size === 0) this.el.removeAttribute("style");
    else this._commit();
  }
  get length(): number {
    this._sync();
    return this._decls.size;
  }
  item(index: number): string {
    this._sync();
    return Array.from(this._decls.keys())[index] ?? "";
  }
  getPropertyValue(name: string): string {
    this._sync();
    return this._decls.get(name.startsWith("--") ? name : name.toLowerCase())?.value ?? "";
  }
  getPropertyPriority(name: string): string {
    this._sync();
    return this._decls.get(name.startsWith("--") ? name : name.toLowerCase())?.priority ?? "";
  }
  setProperty(name: string, value: string | null, priority = ""): void {
    this._sync();
    const key = name.startsWith("--") ? name : name.toLowerCase();
    const v = value == null ? "" : String(value).trim();
    if (v === "") {
      this.removeProperty(key);
      return;
    }
    this._decls.set(key, { value: v, priority: priority === "important" ? "important" : "" });
    this._commit();
  }
  removeProperty(name: string): string {
    this._sync();
    const key = name.startsWith("--") ? name : name.toLowerCase();
    const old = this._decls.get(key)?.value ?? "";
    if (this._decls.delete(key)) this._commit();
    return old;
  }
  *[Symbol.iterator](): IterableIterator<string> {
    this._sync();
    yield* this._decls.keys();
  }
}

/**
 * Property access on a style declaration (`style.color`, `style.marginTop = "4px"`,
 * `style[0]`) maps to the declaration methods, as on a browser's.
 */
function styleProxy(style: ServerStyle): ServerStyle {
  return new Proxy(style, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in target)) {
        if (/^\d+$/.test(key)) return target.item(Number(key));
        return target.getPropertyValue(toKebab(key));
      }
      return Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (typeof key === "string" && !(key in target)) {
        target.setProperty(toKebab(key), value == null ? "" : String(value));
        return true;
      }
      return Reflect.set(target, key, value, receiver);
    },
  });
}

// ─── classList ──────────────────────────────────────────────────────────────

class ServerTokenList {
  constructor(
    private readonly el: ServerElement,
    private readonly attr: string,
  ) {}
  private tokens(): string[] {
    return (this.el.getAttribute(this.attr) ?? "").split(/\s+/).filter(Boolean);
  }
  private write(tokens: string[]): void {
    this.el.setAttribute(this.attr, Array.from(new Set(tokens)).join(" "));
  }
  get length(): number {
    return new Set(this.tokens()).size;
  }
  get value(): string {
    return this.el.getAttribute(this.attr) ?? "";
  }
  set value(v: string) {
    this.el.setAttribute(this.attr, v);
  }
  item(i: number): string | null {
    return Array.from(new Set(this.tokens()))[i] ?? null;
  }
  contains(token: string): boolean {
    return this.tokens().includes(token);
  }
  add(...tokens: string[]): void {
    this.write([...this.tokens(), ...tokens]);
  }
  remove(...tokens: string[]): void {
    this.write(this.tokens().filter((t) => !tokens.includes(t)));
  }
  toggle(token: string, force?: boolean): boolean {
    const has = this.contains(token);
    const want = force === undefined ? !has : force;
    if (want && !has) this.add(token);
    else if (!want && has) this.remove(token);
    return want;
  }
  replace(oldToken: string, newToken: string): boolean {
    const tokens = this.tokens();
    const i = tokens.indexOf(oldToken);
    if (i === -1) return false;
    tokens[i] = newToken;
    this.write(tokens);
    return true;
  }
  forEach(fn: (token: string, index: number) => void): void {
    Array.from(new Set(this.tokens())).forEach(fn);
  }
  [Symbol.iterator](): IterableIterator<string> {
    return new Set(this.tokens()).values();
  }
  toString(): string {
    return this.value;
  }
}

// ─── Element ────────────────────────────────────────────────────────────────

function datasetKeyToAttr(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

export class ServerElement extends ServerNode {
  /** @internal */ _attrs = new ServerNamedNodeMap();
  /** @internal */ _style: ServerStyle | null = null;
  /** @internal */ _classList: ServerTokenList | null = null;

  constructor(
    doc: ServerDocument | null,
    readonly localName: string,
    readonly namespaceURI: string | null,
    readonly prefix: string | null = null,
  ) {
    super(doc);
  }

  override get nodeType(): number {
    return ELEMENT_NODE;
  }
  private get isHtml(): boolean {
    return this.namespaceURI === HTML_NS;
  }
  get tagName(): string {
    const q = this.prefix ? `${this.prefix}:${this.localName}` : this.localName;
    return this.isHtml ? q.toUpperCase() : q;
  }
  override get nodeName(): string {
    return this.tagName;
  }
  get attributes(): ServerNamedNodeMap {
    return this._attrs;
  }

  private findAttr(name: string): ServerAttr | undefined {
    const n = this.isHtml ? name.toLowerCase() : name;
    return this._attrs.find((a) => a.name === n);
  }
  getAttribute(name: string): string | null {
    return this.findAttr(String(name))?.value ?? null;
  }
  getAttributeNames(): string[] {
    return this._attrs.map((a) => a.name);
  }
  hasAttribute(name: string): boolean {
    return this.findAttr(String(name)) !== undefined;
  }
  hasAttributes(): boolean {
    return this._attrs.length > 0;
  }
  setAttribute(name: string, value: unknown): void {
    name = String(name);
    if (!NAME_RE.test(name)) invalidCharacter(name);
    const v = String(value);
    const existing = this.findAttr(name);
    const old = existing ? existing._value : null;
    if (existing) existing._value = v;
    else this._attrs.push(new ServerAttr(this, null, null, this.isHtml ? name.toLowerCase() : name, v));
    this._recordAttr(this.isHtml ? name.toLowerCase() : name, null, old);
  }
  removeAttribute(name: string): void {
    const attr = this.findAttr(String(name));
    if (!attr) return;
    this._attrs.splice(this._attrs.indexOf(attr), 1);
    this._recordAttr(attr.name, attr.namespaceURI, attr._value);
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : force;
    if (want && !has) this.setAttribute(name, "");
    else if (!want && has) this.removeAttribute(name);
    return want;
  }
  getAttributeNS(ns: string | null, localName: string): string | null {
    return this._attrs.getNamedItemNS(ns, localName)?.value ?? null;
  }
  hasAttributeNS(ns: string | null, localName: string): boolean {
    return this._attrs.getNamedItemNS(ns, localName) !== null;
  }
  setAttributeNS(ns: string | null, qualifiedName: string, value: unknown): void {
    if (!NAME_RE.test(qualifiedName)) invalidCharacter(qualifiedName);
    const colon = qualifiedName.indexOf(":");
    const prefix = colon === -1 ? null : qualifiedName.slice(0, colon);
    const localName = colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
    const namespace = ns || null;
    if (namespace === null) {
      this.setAttribute(qualifiedName, value);
      return;
    }
    const existing = this._attrs.getNamedItemNS(namespace, localName);
    const old = existing ? existing._value : null;
    if (existing) existing._value = String(value);
    else this._attrs.push(new ServerAttr(this, namespace, prefix, localName, String(value)));
    this._recordAttr(localName, namespace, old);
  }
  removeAttributeNS(ns: string | null, localName: string): void {
    const attr = this._attrs.getNamedItemNS(ns, localName);
    if (!attr) return;
    this._attrs.splice(this._attrs.indexOf(attr), 1);
    this._recordAttr(localName, attr.namespaceURI, attr._value);
  }
  getAttributeNode(name: string): ServerAttr | null {
    return this.findAttr(name) ?? null;
  }
  /** @internal */
  _recordAttr(name: string, ns: string | null, oldValue: string | null): void {
    if (observations.length === 0) return;
    queueRecord({
      type: "attributes",
      target: this,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
      attributeName: name,
      attributeNamespace: ns,
      oldValue,
    });
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get classList(): ServerTokenList {
    this._classList ??= new ServerTokenList(this, "class");
    return this._classList;
  }
  get style(): ServerStyle {
    this._style ??= styleProxy(new ServerStyle(this));
    return this._style;
  }
  set style(v: string) {
    this.style.cssText = v;
  }
  get dataset(): Record<string, string | undefined> {
    return new Proxy(
      {},
      {
        get: (_t, key) =>
          typeof key === "string" ? (this.getAttribute(datasetKeyToAttr(key)) ?? undefined) : undefined,
        set: (_t, key, value) => {
          if (typeof key === "string") this.setAttribute(datasetKeyToAttr(key), String(value));
          return true;
        },
        deleteProperty: (_t, key) => {
          if (typeof key === "string") this.removeAttribute(datasetKeyToAttr(key));
          return true;
        },
        has: (_t, key) => typeof key === "string" && this.hasAttribute(datasetKeyToAttr(key)),
        ownKeys: () =>
          this._attrs
            .filter((a) => a.name.startsWith("data-"))
            .map((a) => a.name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())),
        getOwnPropertyDescriptor: (_t, key) =>
          typeof key === "string" && this.hasAttribute(datasetKeyToAttr(key))
            ? { enumerable: true, configurable: true, value: this.getAttribute(datasetKeyToAttr(key)) }
            : undefined,
      },
    );
  }

  get innerHTML(): string {
    let out = "";
    for (let n = this._first; n; n = n._next) out += serializeForDebug(n);
    return out;
  }
  set innerHTML(_value: string) {
    unavailable("Element.innerHTML assignment (the server DOM has no HTML parser)");
  }
  get outerHTML(): string {
    return serializeForDebug(this);
  }
  insertAdjacentHTML(): void {
    unavailable("Element.insertAdjacentHTML()");
  }

  matches(selector: string): boolean {
    return matchesCompiled(this, compileSelector(selector), null);
  }
  closest(selector: string): ServerElement | null {
    const sel = compileSelector(selector);
    for (let n: ServerNode | null = this; n; n = n._parent) {
      if (n instanceof ServerElement && matchesCompiled(n, sel, null)) return n;
    }
    return null;
  }

  // ── Layout and focus: no-ops on a server ──
  focus(): void {}
  blur(): void {}
  click(): void {
    const Ctor = (globalThis as { Event?: typeof Event }).Event;
    if (Ctor) this.dispatchEvent(new Ctor("click", { bubbles: true, cancelable: true }));
  }
  scrollIntoView(): void {}
  scrollTo(): void {}
  scrollBy(): void {}
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as DOMRect;
  }
  getClientRects(): DOMRect[] {
    return [];
  }
  get offsetWidth(): number {
    return 0;
  }
  get offsetHeight(): number {
    return 0;
  }
  get offsetTop(): number {
    return 0;
  }
  get offsetLeft(): number {
    return 0;
  }
  get offsetParent(): ServerElement | null {
    return null;
  }
  get clientWidth(): number {
    return 0;
  }
  get clientHeight(): number {
    return 0;
  }
  get scrollWidth(): number {
    return 0;
  }
  get scrollHeight(): number {
    return 0;
  }
  scrollTop = 0;
  scrollLeft = 0;

  // ── Browser-only APIs: a clear error instead of "is not a function" ──
  animate(): never {
    return unavailable("Element.animate()");
  }
  getAnimations(): never {
    return unavailable("Element.getAnimations()");
  }
  attachShadow(): never {
    return unavailable("Element.attachShadow()");
  }
  requestFullscreen(): never {
    return unavailable("Element.requestFullscreen()");
  }
  requestPointerLock(): never {
    return unavailable("Element.requestPointerLock()");
  }
  setPointerCapture(): never {
    return unavailable("Element.setPointerCapture()");
  }

  override _shallowClone(): ServerNode {
    const copy = this.ownerDocument
      ? this.ownerDocument.createElementNS(
          this.namespaceURI,
          this.prefix ? `${this.prefix}:${this.localName}` : this.localName,
        )
      : new ServerElement(null, this.localName, this.namespaceURI, this.prefix);
    for (const a of this._attrs)
      copy._attrs.push(new ServerAttr(copy, a.namespaceURI, a.prefix, a.localName, a._value));
    return copy;
  }
}

export class ServerHTMLElement extends ServerElement {
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(v: boolean) {
    this.toggleAttribute("hidden", !!v);
  }
  get title(): string {
    return this.getAttribute("title") ?? "";
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  get lang(): string {
    return this.getAttribute("lang") ?? "";
  }
  set lang(v: string) {
    this.setAttribute("lang", v);
  }
  get dir(): string {
    return this.getAttribute("dir") ?? "";
  }
  set dir(v: string) {
    this.setAttribute("dir", v);
  }
  get tabIndex(): number {
    const v = Number.parseInt(this.getAttribute("tabindex") ?? "", 10);
    return Number.isNaN(v) ? -1 : v;
  }
  set tabIndex(v: number) {
    this.setAttribute("tabindex", String(v));
  }
  get innerText(): string {
    return this.textContent ?? "";
  }
  set innerText(v: string) {
    this.textContent = v;
  }
}

/** `disabled` reflects to the attribute, as in a browser. */
function reflectDisabled(proto: object): void {
  Object.defineProperty(proto, "disabled", {
    get(this: ServerElement) {
      return this.hasAttribute("disabled");
    },
    set(this: ServerElement, v: boolean) {
      this.toggleAttribute("disabled", !!v);
    },
    configurable: true,
  });
}

/**
 * `<input>`. `value` and `checked` are the control's current state, not its
 * attributes: writing them does not change the markup (the dirty-value /
 * dirty-checkedness rule), exactly as in a browser and in jsdom.
 */
export class ServerInputElement extends ServerHTMLElement {
  /** @internal */ _value: string | null = null;
  /** @internal */ _checked: boolean | null = null;
  get value(): string {
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this._value = v == null ? "" : String(v);
  }
  get defaultValue(): string {
    return this.getAttribute("value") ?? "";
  }
  set defaultValue(v: string) {
    this.setAttribute("value", v);
  }
  get checked(): boolean {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(v: boolean) {
    this._checked = !!v;
  }
  get defaultChecked(): boolean {
    return this.hasAttribute("checked");
  }
  get type(): string {
    return (this.getAttribute("type") ?? "text").toLowerCase();
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  set name(v: string) {
    this.setAttribute("name", v);
  }
  select(): void {}
  setSelectionRange(): void {}
  checkValidity(): boolean {
    return true;
  }
  reportValidity(): boolean {
    return true;
  }
}
reflectDisabled(ServerInputElement.prototype);

export class ServerTextAreaElement extends ServerHTMLElement {
  /** @internal */ _value: string | null = null;
  get value(): string {
    return this._value ?? this.textContent ?? "";
  }
  set value(v: string) {
    this._value = v == null ? "" : String(v);
  }
  get defaultValue(): string {
    return this.textContent ?? "";
  }
  set defaultValue(v: string) {
    this.textContent = v;
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  set name(v: string) {
    this.setAttribute("name", v);
  }
  select(): void {}
  setSelectionRange(): void {}
}
reflectDisabled(ServerTextAreaElement.prototype);

export class ServerOptionElement extends ServerHTMLElement {
  /** @internal */ _selected: boolean | null = null;
  get value(): string {
    return this.getAttribute("value") ?? this.text;
  }
  set value(v: string) {
    this.setAttribute("value", v);
  }
  get text(): string {
    return (this.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  set text(v: string) {
    this.textContent = v;
  }
  get label(): string {
    return this.getAttribute("label") ?? this.text;
  }
  get selected(): boolean {
    return this._selected ?? this.hasAttribute("selected");
  }
  set selected(v: boolean) {
    this._selected = !!v;
  }
  get defaultSelected(): boolean {
    return this.hasAttribute("selected");
  }
}
reflectDisabled(ServerOptionElement.prototype);

export class ServerSelectElement extends ServerHTMLElement {
  get options(): ServerNodeList<ServerOptionElement> {
    return this.querySelectorAll("option") as unknown as ServerNodeList<ServerOptionElement>;
  }
  get selectedIndex(): number {
    const opts = this.options;
    for (let i = 0; i < opts.length; i++) if (opts[i].selected) return i;
    return opts.length > 0 && !this.hasAttribute("multiple") ? 0 : -1;
  }
  set selectedIndex(i: number) {
    this.options.forEach((o, j) => {
      o.selected = j === i;
    });
  }
  get value(): string {
    const i = this.selectedIndex;
    return i === -1 ? "" : this.options[i].value;
  }
  set value(v: string) {
    this.options.forEach((o) => {
      o.selected = o.value === String(v);
    });
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  set name(v: string) {
    this.setAttribute("name", v);
  }
}
reflectDisabled(ServerSelectElement.prototype);

export class ServerButtonElement extends ServerHTMLElement {
  get type(): string {
    return (this.getAttribute("type") ?? "submit").toLowerCase();
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get value(): string {
    return this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this.setAttribute("value", v);
  }
}
reflectDisabled(ServerButtonElement.prototype);

class ServerDisableableElement extends ServerHTMLElement {}
reflectDisabled(ServerDisableableElement.prototype);

export class ServerCanvasElement extends ServerHTMLElement {
  get width(): number {
    return Number(this.getAttribute("width") ?? 300);
  }
  set width(v: number) {
    this.setAttribute("width", String(v));
  }
  get height(): number {
    return Number(this.getAttribute("height") ?? 150);
  }
  set height(v: number) {
    this.setAttribute("height", String(v));
  }
  /** No drawing context on a server: warns and returns `null`, as a browser does for an unsupported context. */
  getContext(): null {
    reportBrowserApi("HTMLCanvasElement.getContext()");
    return null;
  }
  toDataURL(): never {
    return unavailable("HTMLCanvasElement.toDataURL()");
  }
  toBlob(): never {
    return unavailable("HTMLCanvasElement.toBlob()");
  }
}

export class ServerDialogElement extends ServerHTMLElement {
  get open(): boolean {
    return this.hasAttribute("open");
  }
  set open(v: boolean) {
    this.toggleAttribute("open", !!v);
  }
  showModal(): never {
    return unavailable("HTMLDialogElement.showModal()");
  }
  show(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
}

export class ServerMediaElement extends ServerHTMLElement {
  play(): never {
    return unavailable("HTMLMediaElement.play()");
  }
  pause(): void {}
  load(): void {}
}

export class ServerTemplateElement extends ServerHTMLElement {
  /** @internal */ _content: ServerDocumentFragment | null = null;
  get content(): ServerDocumentFragment {
    this._content ??= new ServerDocumentFragment(this.ownerDocument);
    return this._content;
  }
}

export class ServerSVGElement extends ServerElement {}
export class ServerMathMLElement extends ServerElement {}

const HTML_CLASSES: Record<string, new (doc: ServerDocument, name: string, ns: string) => ServerElement> = {
  input: ServerInputElement,
  textarea: ServerTextAreaElement,
  select: ServerSelectElement,
  option: ServerOptionElement,
  button: ServerButtonElement,
  fieldset: ServerDisableableElement,
  optgroup: ServerDisableableElement,
  canvas: ServerCanvasElement,
  dialog: ServerDialogElement,
  video: ServerMediaElement,
  audio: ServerMediaElement,
  template: ServerTemplateElement,
};

// ─── TreeWalker ─────────────────────────────────────────────────────────────

const NODE_FILTER = {
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff,
  SHOW_ELEMENT: 0x1,
  SHOW_ATTRIBUTE: 0x2,
  SHOW_TEXT: 0x4,
  SHOW_COMMENT: 0x80,
  SHOW_DOCUMENT: 0x100,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
};

class ServerTreeWalker {
  currentNode: ServerNode;
  constructor(
    readonly root: ServerNode,
    readonly whatToShow: number,
    readonly filter: ((node: ServerNode) => number) | { acceptNode(node: ServerNode): number } | null,
  ) {
    this.currentNode = root;
  }
  private accept(node: ServerNode): number {
    if (!((1 << (node.nodeType - 1)) & this.whatToShow)) return NODE_FILTER.FILTER_SKIP;
    if (!this.filter) return NODE_FILTER.FILTER_ACCEPT;
    return typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
  }
  nextNode(): ServerNode | null {
    let node: ServerNode | null = this.currentNode;
    for (;;) {
      let next: ServerNode | null = null;
      if (node._first) next = node._first;
      else {
        let n: ServerNode | null = node;
        while (n && n !== this.root && !n._next) n = n._parent;
        next = n && n !== this.root ? n._next : null;
      }
      if (!next) return null;
      node = next;
      if (this.accept(node) === NODE_FILTER.FILTER_ACCEPT) {
        this.currentNode = node;
        return node;
      }
    }
  }
  firstChild(): ServerNode | null {
    for (let n = this.currentNode._first; n; n = n._next) {
      if (this.accept(n) === NODE_FILTER.FILTER_ACCEPT) {
        this.currentNode = n;
        return n;
      }
    }
    return null;
  }
  nextSibling(): ServerNode | null {
    for (let n = this.currentNode._next; n; n = n._next) {
      if (this.accept(n) === NODE_FILTER.FILTER_ACCEPT) {
        this.currentNode = n;
        return n;
      }
    }
    return null;
  }
  parentNode(): ServerNode | null {
    const p = this.currentNode === this.root ? null : this.currentNode._parent;
    if (p) this.currentNode = p;
    return p;
  }
}

// ─── Document ───────────────────────────────────────────────────────────────

export class ServerDocument extends ServerNode {
  readonly documentElement: ServerHTMLElement;
  readonly head: ServerHTMLElement;
  readonly body: ServerHTMLElement;
  readonly defaultView = null;
  readonly readyState = "complete";
  readonly contentType = "text/html";
  readonly characterSet = "UTF-8";
  readonly compatMode = "CSS1Compat";
  readonly visibilityState = "visible";
  readonly hidden = false;
  cookie = "";

  constructor() {
    super(null);
    (this as { ownerDocument: ServerDocument | null }).ownerDocument = null;
    this.documentElement = this.createElement("html") as ServerHTMLElement;
    this.head = this.createElement("head") as ServerHTMLElement;
    this.body = this.createElement("body") as ServerHTMLElement;
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  override get nodeType(): number {
    return DOCUMENT_NODE;
  }
  override get nodeName(): string {
    return "#document";
  }
  get activeElement(): ServerElement {
    return this.body;
  }
  get title(): string {
    return this.head.querySelector("title")?.textContent ?? "";
  }
  set title(v: string) {
    let el = this.head.querySelector("title");
    if (!el) {
      el = this.createElement("title");
      this.head.appendChild(el);
    }
    el.textContent = v;
  }
  /** Font loading does not exist on a server: recorded as a browser-only read, answers `undefined`. */
  get fonts(): undefined {
    reportBrowserApi("document.fonts");
    return undefined;
  }

  createElement(name: string): ServerElement {
    name = String(name);
    if (!NAME_RE.test(name)) invalidCharacter(name);
    const local = name.toLowerCase();
    const Ctor = Object.hasOwn(HTML_CLASSES, local) ? HTML_CLASSES[local] : ServerHTMLElement;
    return new Ctor(this, local, HTML_NS);
  }
  createElementNS(ns: string | null, qualifiedName: string): ServerElement {
    if (!NAME_RE.test(qualifiedName)) invalidCharacter(qualifiedName);
    const namespace = ns || null;
    if (namespace === HTML_NS) return this.createElement(qualifiedName);
    const colon = qualifiedName.indexOf(":");
    const prefix = colon === -1 ? null : qualifiedName.slice(0, colon);
    const local = colon === -1 ? qualifiedName : qualifiedName.slice(colon + 1);
    if (namespace === SVG_NS) return new ServerSVGElement(this, local, namespace, prefix);
    if (namespace === MATHML_NS) return new ServerMathMLElement(this, local, namespace, prefix);
    return new ServerElement(this, local, namespace, prefix);
  }
  createTextNode(data: string): ServerText {
    return new ServerText(this, String(data));
  }
  createComment(data: string): ServerComment {
    return new ServerComment(this, String(data));
  }
  createDocumentFragment(): ServerDocumentFragment {
    return new ServerDocumentFragment(this);
  }
  createTreeWalker(
    root: ServerNode,
    whatToShow = NODE_FILTER.SHOW_ALL,
    filter: ServerTreeWalker["filter"] = null,
  ): ServerTreeWalker {
    return new ServerTreeWalker(root, whatToShow, filter);
  }
  createEvent(): never {
    return unavailable("document.createEvent() (construct `new Event(type)` instead)");
  }
  getElementById(id: string): ServerElement | null {
    return this.querySelector(`#${cssEscapeIdent(id)}`);
  }
  hasFocus(): boolean {
    return false;
  }
  getSelection(): null {
    return null;
  }
  elementFromPoint(): null {
    return null;
  }
  execCommand(): never {
    return unavailable("document.execCommand()");
  }
}

// ─── Selectors ──────────────────────────────────────────────────────────────

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; op: string | null; value: string }>;
}
interface ComplexSelector {
  /** Right to left: compounds[0] is the subject; combinators[i] joins compounds[i] and compounds[i + 1]. */
  compounds: Compound[];
  combinators: Array<" " | ">">;
  scoped: boolean;
}

const selectorCache = new Map<string, ComplexSelector[]>();

function cssEscapeIdent(value: string): string {
  return value.replace(/([^A-Za-z0-9_-])/g, "\\$1");
}

function unescapeIdent(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function compileSelector(selector: string): ComplexSelector[] {
  const cached = selectorCache.get(selector);
  if (cached) return cached;
  const groups: ComplexSelector[] = [];
  for (const part of splitTopLevel(selector, ",")) {
    const text = part.trim();
    if (!text) throw syntaxError(selector);
    const tokens = text.match(/(?:\\.|\[[^\]]*\]|[^\s>])+|>/g) ?? [];
    const compounds: Compound[] = [];
    const combinators: Array<" " | ">"> = [];
    let pending: " " | ">" = " ";
    let scoped = false;
    for (const token of tokens) {
      if (token === ">") {
        pending = ">";
        continue;
      }
      if (token === ":scope") {
        scoped = true;
        pending = " ";
        continue;
      }
      if (compounds.length > 0) combinators.unshift(pending);
      compounds.unshift(parseCompound(token, selector));
      pending = " ";
    }
    if (compounds.length === 0) throw syntaxError(selector);
    groups.push({ compounds, combinators, scoped });
  }
  if (selectorCache.size > 500) selectorCache.clear();
  selectorCache.set(selector, groups);
  return groups;
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i++;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function syntaxError(selector: string): Error {
  const Ctor = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
  const message = `'${selector}' is not a valid selector (the SibuJS server DOM supports tag, #id, .class, [attr], [attr=value], descendant and > combinators)`;
  return Ctor ? new Ctor(message, "SyntaxError") : new Error(message);
}

function parseCompound(token: string, selector: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
  const re = /(\\.|[^#.[\\])+|#((?:\\.|[^#.[\\])+)|\.((?:\\.|[^#.[\\])+)|\[([^\]]*)\]/gy;
  let consumed = 0;
  for (let m = re.exec(token); m; m = re.exec(token)) {
    consumed = re.lastIndex;
    if (m[2] !== undefined) c.id = unescapeIdent(m[2]);
    else if (m[3] !== undefined) c.classes.push(unescapeIdent(m[3]));
    else if (m[4] !== undefined) {
      const am = /^\s*([^\s~|^$*=]+)\s*(?:([~|^$*]?=)\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"']+)))?\s*$/.exec(
        m[4],
      );
      if (!am) throw syntaxError(selector);
      c.attrs.push({
        name: am[1].toLowerCase(),
        op: am[2] ?? null,
        value: unescapeIdent(am[3] ?? am[4] ?? am[5] ?? ""),
      });
    } else {
      const t = m[0];
      if (t.startsWith(":")) throw syntaxError(selector);
      c.tag = t === "*" ? null : unescapeIdent(t);
    }
    if (re.lastIndex === token.length) break;
  }
  if (consumed !== token.length) throw syntaxError(selector);
  return c;
}

function matchesCompound(el: ServerElement, c: Compound): boolean {
  if (c.tag !== null) {
    const isHtml = el.namespaceURI === HTML_NS;
    if (isHtml ? el.localName !== c.tag.toLowerCase() : el.localName !== c.tag) return false;
  }
  if (c.id !== null && el.getAttribute("id") !== c.id) return false;
  if (c.classes.length > 0) {
    const tokens = (el.getAttribute("class") ?? "").split(/\s+/);
    for (const cls of c.classes) if (!tokens.includes(cls)) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === null) continue;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "|=" && v !== a.value && !v.startsWith(`${a.value}-`)) return false;
    if (a.op === "^=" && (!a.value || !v.startsWith(a.value))) return false;
    if (a.op === "$=" && (!a.value || !v.endsWith(a.value))) return false;
    if (a.op === "*=" && (!a.value || !v.includes(a.value))) return false;
  }
  return true;
}

function matchesCompiled(el: ServerElement, groups: ComplexSelector[], scope: ServerNode | null): boolean {
  for (const g of groups) if (matchesComplex(el, g, 0, scope)) return true;
  return false;
}

function matchesComplex(el: ServerElement, g: ComplexSelector, i: number, scope: ServerNode | null): boolean {
  if (!matchesCompound(el, g.compounds[i])) return false;
  if (i === g.compounds.length - 1) {
    if (!g.scoped || !scope) return true;
    return el._parent === scope || (g.combinators.length === 0 ? false : scope.contains(el));
  }
  const comb = g.combinators[i];
  for (let p = el._parent; p && p instanceof ServerElement; p = p._parent) {
    if (scope && p === scope && g.scoped) return false;
    if (matchesComplex(p, g, i + 1, scope)) return true;
    if (comb === ">") return false;
  }
  return false;
}

// ─── Debug serialization (innerHTML / outerHTML getters) ────────────────────

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeForDebug(node: ServerNode): string {
  if (node.nodeType === TEXT_NODE) return escapeText((node as ServerText).data);
  if (node.nodeType === COMMENT_NODE) return `<!--${(node as ServerComment).data}-->`;
  if (node.nodeType !== ELEMENT_NODE) {
    let out = "";
    for (let n = node._first; n; n = n._next) out += serializeForDebug(n);
    return out;
  }
  const el = node as ServerElement;
  const tag = el.prefix ? `${el.prefix}:${el.localName}` : el.localName;
  let out = `<${tag}`;
  for (const a of el._attrs) out += ` ${a.name}="${escapeText(a._value).replace(/"/g, "&quot;")}"`;
  out += ">";
  if (el.namespaceURI === HTML_NS && VOID.has(el.localName)) return out;
  for (let n = el._first; n; n = n._next) out += serializeForDebug(n);
  return `${out}</${tag}>`;
}

// ─── Installation ───────────────────────────────────────────────────────────

/** Create a standalone server document (nothing global is touched). */
export function createServerDocument(): ServerDocument {
  return new ServerDocument();
}

const INSTALLED = Symbol.for("sibujs.serverDom.v1");

/** True when the global `document` is a SibuJS server document. */
export function isServerDom(): boolean {
  return typeof document !== "undefined" && (document as unknown) instanceof ServerDocument;
}

/**
 * Register the server DOM as the global DOM (`document`, `Node`, `Element`,
 * `HTMLElement`, `SVGElement`, `Text`, `Comment`, `DocumentFragment`,
 * `MutationObserver`, `NodeFilter`, and the form-control element classes).
 *
 * Does nothing when a DOM is already registered — happy-dom and jsdom keep
 * working, and win — unless `force` is set. `window` is NOT defined.
 *
 * @param options `force` replaces an existing DOM.
 * @returns A function that restores the previous globals.
 */
export function installServerDom(options: { force?: boolean } = {}): () => void {
  const g = globalThis as Record<string | symbol, unknown>;
  if (typeof g.document !== "undefined" && !options.force) return () => {};
  const globals: Record<string, unknown> = {
    document: new ServerDocument(),
    Node: ServerNode,
    Element: ServerElement,
    HTMLElement: ServerHTMLElement,
    SVGElement: ServerSVGElement,
    MathMLElement: ServerMathMLElement,
    HTMLInputElement: ServerInputElement,
    HTMLTextAreaElement: ServerTextAreaElement,
    HTMLSelectElement: ServerSelectElement,
    HTMLOptionElement: ServerOptionElement,
    HTMLButtonElement: ServerButtonElement,
    HTMLCanvasElement: ServerCanvasElement,
    HTMLDialogElement: ServerDialogElement,
    HTMLTemplateElement: ServerTemplateElement,
    Text: ServerText,
    Comment: ServerComment,
    CharacterData: ServerCharacterData,
    DocumentFragment: ServerDocumentFragment,
    Document: ServerDocument,
    Attr: ServerAttr,
    MutationObserver: ServerMutationObserver,
    NodeFilter: NODE_FILTER,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { value, configurable: true, writable: true, enumerable: false });
  }
  g[INSTALLED] = true;
  return () => {
    for (const [key, desc] of previous) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
    delete g[INSTALLED];
  };
}

// ─── Browser-API reads under a full DOM emulation ───────────────────────────

/** Globals that only mean something in a browser, by the name a component reads. */
const BROWSER_GLOBALS = [
  "matchMedia",
  "requestAnimationFrame",
  "localStorage",
  "sessionStorage",
  "IntersectionObserver",
  "ResizeObserver",
] as const;

const WATCHED = Symbol.for("sibujs.serverDom.watched.v1");

function inServerRender(): boolean {
  const shared = (
    globalThis as Record<symbol, { als?: { getStore(): { ssr?: boolean } | undefined } | null } | undefined>
  )[Symbol.for("sibujs.ssr.v1")];
  return !!shared?.als?.getStore()?.ssr;
}

function watchProperty(target: object, key: string, api: string): void {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (!desc || !desc.configurable) return;
  const read = desc.get ? () => desc.get?.call(target) : () => desc.value;
  let value = desc.value;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      if (inServerRender()) reportBrowserApi(api);
      return desc.get ? read() : value;
    },
    set(v) {
      if (desc.set) desc.set.call(target, v);
      else value = v;
    },
  });
}

/**
 * Under happy-dom or jsdom the browser-only globals EXIST, so a component that
 * reads them during a server render runs silently against an emulation. In
 * development, wrap them so a read made inside a server render is reported
 * (warning + `diagnostics.browserApis`) and still answers as before. Reads
 * outside a server render — a client test in the same process — are untouched.
 * Installed once per realm; a no-op on the server DOM, where those globals do
 * not exist and a read throws a ReferenceError instead.
 * @internal
 */
export function watchBrowserApis(): void {
  if (!DEV || isServerDom()) return;
  const g = globalThis as Record<string | symbol, unknown>;
  if (g[WATCHED]) return;
  g[WATCHED] = true;
  const win = g.window as Record<string, unknown> | undefined;
  for (const key of BROWSER_GLOBALS) {
    if (Object.hasOwn(g, key)) watchProperty(g, key, key);
    if (win && win !== g && Object.hasOwn(win, key)) watchProperty(win, key, `window.${key}`);
  }
  const Doc = g.Document as { prototype: object } | undefined;
  if (Doc && "fonts" in Doc.prototype) watchProperty(Doc.prototype, "fonts", "document.fonts");
  const Canvas = g.HTMLCanvasElement as { prototype: { getContext?: (...args: unknown[]) => unknown } } | undefined;
  const getContext = Canvas?.prototype.getContext;
  if (Canvas && getContext) {
    Canvas.prototype.getContext = function (this: unknown, ...args: unknown[]) {
      if (inServerRender()) reportBrowserApi("HTMLCanvasElement.getContext()");
      return getContext.apply(this, args);
    };
  }
}

const BROWSER_ONLY_NAMES =
  /^(window|self|localStorage|sessionStorage|requestAnimationFrame|cancelAnimationFrame|matchMedia|IntersectionObserver|ResizeObserver|getComputedStyle|location|history|screen|innerWidth|innerHeight|scrollY|scrollX|devicePixelRatio) is not defined$/;

/**
 * Turn the ReferenceError a browser global raises in a server render into an
 * error naming the API, the calling site, and the fix.
 * @internal
 */
export function explainServerError(err: unknown): unknown {
  if (!(err instanceof ReferenceError)) return err;
  const m = BROWSER_ONLY_NAMES.exec(err.message);
  if (!m) return err;
  const site =
    (err.stack ?? "")
      .split("\n")[1]
      ?.trim()
      .replace(/^at\s+/, "") ?? "(unknown site)";
  return new Error(
    `[SibuJS SSR] browser-only API \`${m[1]}\` used during a server render (${site}). ` +
      "Move the code into onMount() or an effect, or render the component with ClientOnly().",
    { cause: err },
  );
}

/**
 * Make sure SOME DOM is registered before a server render builds its tree:
 * an existing one (happy-dom, jsdom) is used as is, otherwise the server DOM
 * is installed and left in place for the process.
 * @internal
 */
export function ensureServerDom(): void {
  if (typeof document === "undefined") installServerDom();
}
