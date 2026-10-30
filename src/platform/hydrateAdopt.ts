// ============================================================================
// ADOPTING HYDRATION — hydrate(App, root, { strategy: "adopt" })
// ============================================================================
//
// The replace strategy builds a fresh client tree and swaps it in. Adoption
// builds the client tree ON the server markup: every element a builder
// creates is matched to the server element with the same creation-scope id
// (`data-sibu-h`, see `core/rendering/adoptScope.ts`) and RETURNED instead of
// a new one, so bindings, listeners and refs attach to the nodes already on
// screen. Images do not reload, typed input stays, focus and scroll stay.
//
// Placement. While a claimed element is being built, its `appendChild` puts
// each child at a cursor walking the server children: a claimed child already
// there is left in place; a fresh text or comment node takes the place of the
// server one it corresponds to (one node swap, no element created); anything
// else is inserted at the cursor. Directives inserting after an anchor find
// their adopted node already there and do nothing.
//
// Attributes. A claimed element ends with exactly the attributes the client
// writes, through the client's own policy: server attributes are removed at
// claim, except the ones whose removal would change the element's live state
// (`src` / `srcset` on media, a form control's `value` / `checked`, `open`).
// Those are kept only if they pass the URL policy and the client writes or
// reads them; the rest go when the session ends.
//
// Mismatch. A claim that fails creates a fresh element; when the session ends,
// server nodes nobody claimed are removed. So a divergent subtree is replaced
// on its own and everything around it stays adopted. Each divergence is
// reported (dev warning, or `onMismatch`) with where it happened, both sides,
// and the likely cause.

import { DEV } from "../core/dev";
import { type AdoptScope, type AdoptSink, inAdoptScope, inScope } from "../core/rendering/adoptScope";
import { beginHydration, hydrationPending } from "../core/rendering/hydrationHooks";
import { resolveAttributeValue } from "../utils/sanitize";
import { describeNodePath } from "./ssrAsync";

/** Attribute carrying an element's creation-scope id in adopt-marked server output. */
export const ADOPT_ID_ATTR = "data-sibu-h";

// ─── Server side ────────────────────────────────────────────────────────────

/**
 * A sink for an adopt-marked server render: elements are created normally and
 * their ids recorded, for the serializer to emit as `data-sibu-h`.
 * @internal
 */
export function createServerAdoptScope(ids: WeakMap<Element, string>): AdoptScope {
  const sink: AdoptSink = {
    on: true,
    el(tag, ns, id) {
      const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
      ids.set(el, id);
      return el;
    },
  };
  return { p: "", n: 0, s: sink };
}

// ─── Browser side ───────────────────────────────────────────────────────────

/** One divergence between the server markup and the client tree. */
export interface AdoptMismatch {
  kind: "tag" | "missing" | "extra" | "text";
  /** Where: the DOM path of the server node (or of the parent the client node went into). */
  path: string;
  /** The creation-scope id involved, when there is one. */
  id: string | null;
  serverValue: string;
  clientValue: string;
  /** What usually causes this divergence. */
  cause: string;
  message: string;
}

/** Options of an adopting `hydrate()`. */
export interface AdoptOptions {
  /** Called for every divergence instead of the development warning. */
  onMismatch?: (report: AdoptMismatch) => void;
  /**
   * How long to wait for lazy chunks and route loads before releasing the
   * server markup nothing claimed. Default 10 000 ms.
   */
  timeout?: number;
}

/** What an adopting hydration did. */
export interface AdoptResult {
  /** Server elements reused as client elements. */
  adopted: number;
  /** Elements the client had to create (0 on matching markup). */
  created: number;
  /** Server nodes removed because nothing claimed them. */
  removed: number;
  /** Every divergence found. */
  mismatches: AdoptMismatch[];
  /** True when the root itself did not match and the whole tree was replaced. */
  replacedRoot: boolean;
}

/** Attributes whose removal would change an element's live state; kept while their value passes the policy. */
const STICKY: Record<string, readonly string[]> = {
  img: ["src", "srcset", "sizes"],
  source: ["src", "srcset", "sizes"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["value", "checked", "type"],
  textarea: [],
  select: [],
  option: ["value", "selected"],
  details: ["open"],
  dialog: ["open"],
};

interface ClaimRecord {
  /** Sticky server attributes still awaiting a client write or read. */
  sticky: Set<string>;
}

const nativeAppend = (parent: Node, child: Node) => Node.prototype.appendChild.call(parent, child);
const nativeInsert = (parent: Node, child: Node, ref: Node | null) =>
  Node.prototype.insertBefore.call(parent, child, ref);
const nativeReplace = (parent: Node, child: Node, old: Node) => Node.prototype.replaceChild.call(parent, child, old);

function sameKind(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && (a.nodeType === 3 || a.nodeType === 8);
}

function isDirty(el: Element): boolean {
  const tag = el.localName;
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") return input.checked !== input.hasAttribute("checked");
    return input.value !== (input.getAttribute("value") ?? "");
  }
  if (tag === "textarea") return (el as HTMLTextAreaElement).value !== (el.textContent ?? "");
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    return Array.from(select.options).some((o) => o.selected !== o.hasAttribute("selected"));
  }
  return false;
}

class AdoptSession implements AdoptSink {
  readonly byId = new Map<string, Element>();
  readonly server = new WeakSet<Node>();
  readonly claimed = new Map<Element, ClaimRecord>();
  readonly cursors = new WeakMap<Node, Node | null>();
  readonly patched: Node[] = [];
  readonly touched = new Set<Element>();
  readonly mismatches: AdoptMismatch[] = [];
  created = 0;
  removed = 0;
  /** AdoptSink: numbering and claiming are on for the length of the session. */
  on = true;

  constructor(
    readonly root: Element,
    readonly options: AdoptOptions,
  ) {
    const walk = (node: Node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        this.server.add(child);
        if (child.nodeType === 1) {
          const id = (child as Element).getAttribute(ADOPT_ID_ATTR);
          if (id !== null && !this.byId.has(id)) this.byId.set(id, child as Element);
          walk(child);
        }
      }
    };
    walk(root);
    this.patchParent(root);
  }

  report(m: Omit<AdoptMismatch, "message">): void {
    const message =
      m.kind === "tag"
        ? `server rendered <${m.serverValue}>, the client built <${m.clientValue}> — the subtree is replaced`
        : m.kind === "missing"
          ? `the client built <${m.clientValue}>, which the server did not render`
          : m.kind === "extra"
            ? `the server rendered ${m.serverValue}, which the client did not build — removed`
            : `text differs: server "${m.serverValue}", client "${m.clientValue}"`;
    const report: AdoptMismatch = { ...m, message };
    this.mismatches.push(report);
    if (this.options.onMismatch) this.options.onMismatch(report);
    else if (DEV && this.mismatches.length <= 10) {
      console.warn(
        `[SibuJS hydration] adopt mismatch at ${m.path}${m.id ? ` (id ${m.id})` : ""}: ${message}.\n  Likely cause: ${m.cause}`,
      );
    }
  }

  // ── AdoptSink: claim the server element with this id ──
  el(tag: string, ns: string | undefined, id: string): Element | null {
    if (!this.on) return null;
    const candidate = this.byId.get(id);
    const want = ns ?? "http://www.w3.org/1999/xhtml";
    if (
      candidate &&
      candidate.localName === tag &&
      (candidate.namespaceURI ?? want) === want &&
      !this.claimed.has(candidate)
    ) {
      this.byId.delete(id);
      this.claim(candidate);
      return candidate;
    }
    this.created++;
    if (candidate) {
      this.report({
        kind: "tag",
        path: describeNodePath(candidate),
        id,
        serverValue: candidate.localName,
        clientValue: tag,
        cause:
          "the server and the client took different branches: a browser-only read (window, matchMedia, storage) " +
          "during render, data that differs between them, or a non-deterministic render (Date.now(), Math.random()). " +
          "Render browser-only content with ClientOnly().",
      });
    } else {
      this.report({
        kind: "missing",
        path: "(new element)",
        id,
        serverValue: "(none)",
        clientValue: tag,
        cause:
          "the client built more than the server: data the server did not have (a query with ssr: false, a " +
          "timed-out fetch), or a branch that depends on the browser. ClientOnly() renders it after takeover.",
      });
    }
    return null;
  }

  private claim(el: Element): void {
    el.removeAttribute(ADOPT_ID_ATTR);
    const keep = STICKY[el.localName] ?? [];
    const sticky = new Set<string>();
    for (const attr of Array.from(el.attributes)) {
      if (keep.includes(attr.name)) {
        // Kept only through the client's own policy: a value cached markup or
        // a proxy injected (`javascript:`) does not survive.
        const safe = resolveAttributeValue(attr.name, attr.value, { element: el });
        if (safe === null) el.removeAttribute(attr.name);
        else {
          if (safe !== attr.value) el.setAttribute(attr.name, safe);
          sticky.add(attr.name);
        }
      } else el.removeAttribute(attr.name);
    }
    this.claimed.set(el, { sticky });
    if (isDirty(el)) this.touched.add(el);
    this.patchParent(el);
  }

  /**
   * Instance overrides on an adopted parent for the length of the session —
   * the core's own `appendChild` / `insertBefore` calls then place children
   * on the server nodes instead of moving them. Removed when the session ends.
   */
  private patchParent(parent: Element): void {
    const session = this;
    const record = this.claimed.get(parent);
    this.cursors.set(parent, parent.firstChild);
    this.patched.push(parent);
    const own = parent as unknown as Record<string, unknown>;
    own.appendChild = function (this: Node, child: Node) {
      // A builder appending its children (inside a scope) places them on the
      // server nodes; anything else (a mount callback) appends as usual.
      if (inAdoptScope() || child.nodeType === 11) return session.place(this, child);
      return nativeAppend(this, child);
    };
    own.insertBefore = function (this: Node, child: Node, ref: Node | null) {
      return session.insertAt(this, child, ref);
    };
    own.replaceChildren = function (this: Node, ...nodes: Array<Node | string>) {
      session.cursors.set(this, this.firstChild);
      for (const n of nodes) session.place(this, typeof n === "string" ? document.createTextNode(n) : n);
      let rest = session.cursors.get(this) ?? null;
      while (rest) {
        const next = rest.nextSibling;
        this.removeChild(rest);
        rest = next;
      }
    };
    const textDesc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (textDesc?.set && textDesc.get) {
      Object.defineProperty(parent, "textContent", {
        configurable: true,
        get() {
          return textDesc.get?.call(this);
        },
        set(value: string | null) {
          const text = value == null ? "" : String(value);
          const only = this.firstChild;
          if (only && only === this.lastChild && only.nodeType === 3 && (only as Text).data === text) {
            session.server.delete(only);
            return;
          }
          textDesc.set?.call(this, value);
        },
      });
    }
    if (record) {
      // Record the client's interest in a sticky attribute (a write, or the
      // writer's read-before-write), so it survives the session's end.
      const note = (name: string) => record.sticky.delete(String(name).toLowerCase());
      const { getAttribute, setAttribute, removeAttribute } = Element.prototype;
      own.getAttribute = function (this: Element, name: string) {
        note(name);
        return getAttribute.call(this, name);
      };
      own.setAttribute = function (this: Element, name: string, value: string) {
        note(name);
        return setAttribute.call(this, name, value);
      };
      own.removeAttribute = function (this: Element, name: string) {
        note(name);
        return removeAttribute.call(this, name);
      };
      if (this.touched.has(parent)) {
        // What the user typed before the bundle loaded wins over the first
        // client write; the app's handlers learn it from the events replayed
        // when the session ends.
        for (const prop of ["value", "checked"] as const) {
          if (prop in parent) {
            Object.defineProperty(parent, prop, {
              configurable: true,
              get() {
                const desc = findDescriptor(Object.getPrototypeOf(this), prop);
                return desc?.get?.call(this);
              },
              set() {},
            });
          }
        }
      }
    }
  }

  /** Put `child` at the cursor of `parent`. */
  place(parent: Node, child: Node): Node {
    if (child.nodeType === 11) {
      for (const n of Array.from(child.childNodes)) this.place(parent, n);
      return child;
    }
    let cur = this.cursors.has(parent) ? (this.cursors.get(parent) ?? null) : null;
    if (child === cur) {
      this.cursors.set(parent, child.nextSibling);
      return child;
    }
    // An adopted element further along is already in its place: the server
    // nodes before it are a directive's branch content, claimed later.
    if (child.parentNode === parent && this.claimed.has(child as Element) && this.follows(cur, child)) {
      this.cursors.set(parent, child.nextSibling);
      return child;
    }
    // A fresh text or comment node corresponds to the next server node of its
    // kind (a comment: with the same text), past such branch content.
    if (!child.parentNode && (child.nodeType === 3 || child.nodeType === 8)) {
      const match = this.findCounterpart(cur, child);
      if (match) cur = match;
    }
    if (cur && this.server.has(cur) && !this.claimed.has(cur as Element) && sameKind(cur, child) && !child.parentNode) {
      if (child.nodeType === 3) {
        const serverText = cur as Text;
        const clientText = (child as Text).data;
        if (clientText !== "" && serverText.data !== clientText && serverText.data.startsWith(clientText)) {
          // The parser merged adjacent text nodes; split the server's back apart.
          serverText.data = serverText.data.slice(clientText.length);
          nativeInsert(parent, child, serverText);
          return child;
        }
        if (serverText.data !== clientText) {
          this.report({
            kind: "text",
            path: describeNodePath(parent),
            id: null,
            serverValue: serverText.data.slice(0, 80),
            clientValue: clientText.slice(0, 80),
            cause:
              "the text was computed differently: a non-deterministic value (Date.now(), Math.random(), a " +
              "locale-dependent format) or data that changed between render and takeover. The client text is kept.",
          });
        }
      }
      this.server.delete(cur);
      this.cursors.set(parent, cur.nextSibling);
      nativeReplace(parent, child, cur);
      return child;
    }
    nativeInsert(parent, child, cur);
    return child;
  }

  /** Is `node` at or after `from` among its siblings? */
  private follows(from: Node | null, node: Node): boolean {
    for (let n = from; n; n = n.nextSibling) if (n === node) return true;
    return false;
  }

  /**
   * The server node a fresh text / comment child stands for: the first
   * unconsumed server node of the same kind from `from` on (a comment must
   * carry the same text), skipping unclaimed server nodes in between — a
   * preceding directive's branch content — but never an adopted element.
   */
  private findCounterpart(from: Node | null, child: Node): Node | null {
    for (let n = from; n; n = n.nextSibling) {
      if (!this.server.has(n)) return null;
      if (n.nodeType === 1 && this.claimed.has(n as Element)) return null;
      if (n.nodeType !== child.nodeType) continue;
      if (n.nodeType === 8 && (n as Comment).data !== (child as Comment).data) continue;
      return n;
    }
    return null;
  }

  /** `insertBefore` on an adopted parent: no-op when already in place; a fresh text/comment takes the server one's place. */
  insertAt(parent: Node, child: Node, ref: Node | null): Node {
    if (child === ref || (child.parentNode === parent && child.nextSibling === ref)) return child;
    if (child.nodeType === 11) {
      for (const n of Array.from(child.childNodes)) this.insertAt(parent, n, ref);
      return child;
    }
    if (ref && !child.parentNode && this.server.has(ref) && sameKind(ref, child)) {
      if (child.nodeType === 3 && (ref as Text).data !== (child as Text).data) {
        this.report({
          kind: "text",
          path: describeNodePath(parent),
          id: null,
          serverValue: (ref as Text).data.slice(0, 80),
          clientValue: (child as Text).data.slice(0, 80),
          cause:
            "the text was computed differently: a non-deterministic value (Date.now(), Math.random(), a " +
            "locale-dependent format) or data that changed between render and takeover. The client text is kept.",
        });
      }
      this.server.delete(ref);
      if (this.cursors.get(parent) === ref) this.cursors.set(parent, ref.nextSibling);
      nativeReplace(parent, child, ref);
      return child;
    }
    return nativeInsert(parent, child, ref);
  }

  /** End of the session: release unclaimed server nodes, restore the instances, replay input. */
  finish(): void {
    this.on = false;
    for (const node of this.patched) {
      const own = node as unknown as Record<string, unknown>;
      for (const key of [
        "appendChild",
        "insertBefore",
        "replaceChildren",
        "textContent",
        "getAttribute",
        "setAttribute",
        "removeAttribute",
        "value",
        "checked",
      ]) {
        if (Object.hasOwn(own, key)) delete own[key];
      }
    }
    // Unclaimed server nodes: what the client did not build.
    const sweep = (node: Node) => {
      for (let child = node.firstChild; child; ) {
        const next = child.nextSibling;
        if (this.server.has(child) && !this.claimed.has(child as Element)) {
          // Only an element the server built through a scope is a divergence;
          // an unmarked one is a placeholder (a loading or error box).
          if (child.nodeType === 1 && (child as Element).hasAttribute(ADOPT_ID_ATTR)) {
            this.report({
              kind: "extra",
              path: describeNodePath(child),
              id: (child as Element).getAttribute(ADOPT_ID_ATTR),
              serverValue: `<${(child as Element).localName}>`,
              clientValue: "(none)",
              cause:
                "the client built less than the server, or built it under another scope: a branch that renders " +
                "differently in the browser, or a component whose structure depends on timing.",
            });
          }
          child.parentNode?.removeChild(child);
          this.removed++;
        } else if (child.nodeType === 1) sweep(child);
        child = next;
      }
    };
    sweep(this.root);
    // Sticky attributes the client never wrote or read are not its markup.
    for (const [el, record] of this.claimed) {
      for (const name of record.sticky) el.removeAttribute(name);
    }
    // Input made before takeover: tell the app's handlers about it.
    for (const el of this.touched) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

function findDescriptor(proto: object | null, key: string): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  return undefined;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Adopt server markup: build `component()` on the existing nodes of
 * `container`. Resolves once deferred renders, lazy chunks and route loads have
 * settled (or `timeout` elapsed) and the unclaimed server nodes are released.
 * @internal — reached through `hydrate(App, root, { strategy: "adopt" })`.
 */
export async function hydrateAdopt(
  component: () => Node,
  container: Element,
  options: AdoptOptions = {},
): Promise<AdoptResult> {
  const end = beginHydration();
  const session = new AdoptSession(container, options);
  const rootScope: AdoptScope = { p: "", n: 0, s: session };
  let replacedRoot = false;
  try {
    const tree = inScope(rootScope, component);
    // The root: in place when it was claimed; otherwise placed at the start.
    if (tree.parentNode !== container) {
      if (tree.nodeType === 1 && !session.claimed.has(tree as Element)) {
        replacedRoot = true;
        if (DEV && !options.onMismatch) {
          console.warn(
            "[SibuJS hydration] adopt: the root element did not match the server markup, so the whole tree is " +
              'replaced. Was the server render made with { hydration: "adopt" } and the same root component?',
          );
        }
      }
      inScope(rootScope, () => session.place(container, tree));
    }

    // Deferred first renders run in microtasks; lazy chunks and route loads
    // are registered with the session. Wait for both, bounded.
    const deadline = Date.now() + (options.timeout ?? 10_000);
    const pending = hydrationPending();
    for (;;) {
      await macrotask();
      if (!pending || pending.pending.size === 0) {
        await macrotask();
        if (!pending || pending.pending.size === 0) break;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const registry = pending;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (registry.wake === done) registry.wake = null;
          resolve();
        };
        const timer = setTimeout(done, remaining);
        registry.wake = done;
      });
    }
    session.finish();
  } finally {
    end();
  }
  container.setAttribute("data-sibu-hydrated", "adopt");
  return {
    adopted: session.claimed.size,
    created: session.created,
    removed: session.removed,
    mismatches: session.mismatches,
    replacedRoot,
  };
}
