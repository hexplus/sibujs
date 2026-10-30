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

/**
 * A `<select>` the user changed before takeover, as it was when the session
 * started. `chosen` is the exact selection — possibly EMPTY, which is a
 * selection too (a cleared multiple select, `selectedIndex = -1`), and not the
 * same as having no snapshot at all. Each chosen option keeps its node, for
 * when it survives adoption, and its value plus its occurrence among the
 * options with that value, for when the client rebuilt it.
 */
interface SelectSnapshot {
  chosen: Array<{ node: HTMLOptionElement; value: string; occurrence: number }>;
  /** Every option the server rendered: an option not in it was built by the client. */
  server: Set<HTMLOptionElement>;
}

function snapshotSelect(select: HTMLSelectElement): SelectSnapshot {
  const options = Array.from(select.options);
  const seen = new Map<string, number>();
  const chosen: SelectSnapshot["chosen"] = [];
  for (const node of options) {
    const occurrence = seen.get(node.value) ?? 0;
    seen.set(node.value, occurrence + 1);
    if (node.selected) chosen.push({ node, value: node.value, occurrence });
  }
  return { chosen, server: new Set(options) };
}

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

/**
 * An option the HTML spec treats as disabled: its own `disabled`, or that of
 * the `<optgroup>` it is a child of. `option.disabled` reflects only the first.
 */
function isOptionDisabled(option: HTMLOptionElement): boolean {
  const parent = option.parentElement;
  return option.disabled || (parent?.localName === "optgroup" && parent.hasAttribute("disabled"));
}

/**
 * The options a `<select>` selects from its markup alone — what the parser
 * chose before anyone touched it.
 *
 * EXPLICIT selection comes from `selected` attributes and holds even on a
 * disabled option: every marked option of a multiple select, else the last
 * marked one. Only when nothing is marked does a drop-down choose an IMPLICIT
 * default, and engines disagree on which (the spec: the first option not
 * disabled, its optgroup's `disabled` included; WebKit ignores the optgroup's;
 * engines differ again when every option is disabled). So the default is read
 * from this engine itself: the select's markup — attributes only, which the
 * user's choices do not touch — is parsed again in an inert document, where
 * nothing loads or runs. Where that is unavailable the spec's rule stands in.
 */
function defaultSelection(select: HTMLSelectElement): Set<HTMLOptionElement> {
  const options = Array.from(select.options);
  const parsed = reparsedSelection(select, options);
  if (parsed) return parsed;
  const marked = options.filter((o) => o.hasAttribute("selected"));
  if (select.multiple) return new Set(marked);
  if (marked.length > 0) return new Set([marked[marked.length - 1]]);
  if (select.size > 1) return new Set();
  const first = options.find((o) => !isOptionDisabled(o));
  return new Set(first ? [first] : []);
}

/** The selection this engine's parser gives `select`'s markup, mapped onto `options`; `null` when it cannot tell. */
function reparsedSelection(select: HTMLSelectElement, options: HTMLOptionElement[]): Set<HTMLOptionElement> | null {
  if (typeof DOMParser !== "function") return null;
  try {
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${select.outerHTML}`, "text/html");
    const copy = doc.querySelector("select");
    if (!copy || copy.options.length !== options.length) return null;
    const chosen = new Set<HTMLOptionElement>();
    Array.from(copy.options).forEach((o, i) => {
      if (o.selected) chosen.add(options[i]);
    });
    return chosen;
  } catch {
    return null;
  }
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
    // Compared with the markup's own default, not with `selected` attributes:
    // a drop-down with none still selects its first option, untouched.
    const select = el as HTMLSelectElement;
    const initial = defaultSelection(select);
    return Array.from(select.options).some((o) => o.selected !== initial.has(o));
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
  /**
   * The selection of each `<select>` the user changed before takeover. Taken
   * before any client code runs: the client builds a select's options BEFORE
   * the select, and an option's `selected` write changes the selection long
   * before the select itself is claimed. Session-scoped: the references go
   * with the session.
   */
  readonly selections = new Map<HTMLSelectElement, SelectSnapshot>();
  /**
   * Checkboxes and radios the user changed before takeover, and their state —
   * for the same reason: checking a radio unchecks its group, so the client
   * writing a sibling (or a sibling joining the group) changes this one first.
   */
  readonly checks = new Map<HTMLInputElement, boolean>();
  /** Form controls whose state differed from their markup when the session started: the user's. */
  readonly dirty = new Set<Element>();
  created = 0;
  removed = 0;
  /** AdoptSink: numbering and claiming are on for the length of the session. */
  on = true;
  private restored = false;

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
          const tag = (child as Element).localName;
          if ((tag === "select" || tag === "input" || tag === "textarea") && isDirty(child as Element)) {
            this.dirty.add(child as Element);
            if (tag === "select") {
              this.selections.set(child as HTMLSelectElement, snapshotSelect(child as HTMLSelectElement));
            } else if (tag === "input") {
              const input = child as HTMLInputElement;
              if (input.type === "checkbox" || input.type === "radio") this.checks.set(input, input.checked);
            }
          }
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
    // Decided when the session started, not here: by the time a select is
    // claimed its options' client writes have changed its selection, and a
    // radio's siblings may have changed it too.
    if (this.dirty.has(el)) this.touched.add(el);
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
      // A select is not overridden: its options' writes reach its selection
      // anyway, so the session puts the snapshot back when it ends (`reselect`).
      if (this.touched.has(parent) && parent.localName !== "select") {
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

  /** Remove every instance override; idempotent, and also run when the build throws. */
  restore(): void {
    this.on = false;
    if (this.restored) return;
    this.restored = true;
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
  }

  /** End of the session: restore the instances, release unclaimed server nodes, replay input. */
  finish(): void {
    this.restore();
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
    reselect(this);
    // Input made before takeover: tell the app's handlers about it.
    for (const el of this.touched) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

/**
 * The options of the final `select` that stand for the snapshot's selection,
 * one for one:
 *
 * - a chosen option still in the select, with the same value, is itself — its
 *   node, wherever the client moved it;
 * - a chosen option the client REBUILT (its node is gone) is matched among the
 *   options the client built, with the same value: the one at the same
 *   occurrence among those, else the first one not matched yet. When values
 *   repeat this is a best guess — nothing identifies a rebuilt option better
 *   — but it never selects more options than were chosen, and never one the
 *   server rendered and the user left alone;
 * - a chosen option with no counterpart is dropped.
 */
function survivingSelection(select: HTMLSelectElement, snapshot: SelectSnapshot): Set<HTMLOptionElement> {
  const options = Array.from(select.options);
  const present = new Set(options);
  const result = new Set<HTMLOptionElement>();
  const rebuilt = new Map<string, HTMLOptionElement[]>();
  for (const o of options) {
    if (snapshot.server.has(o)) continue;
    const list = rebuilt.get(o.value);
    if (list) list.push(o);
    else rebuilt.set(o.value, [o]);
  }
  const lost: SelectSnapshot["chosen"] = [];
  for (const entry of snapshot.chosen) {
    // A node the client claimed for a DIFFERENT option (its value changed) is
    // not the option the user chose.
    if (present.has(entry.node) && entry.node.value === entry.value) result.add(entry.node);
    else lost.push(entry);
  }
  for (const entry of lost) {
    const candidates = rebuilt.get(entry.value);
    if (!candidates) continue;
    const atOccurrence = candidates[entry.occurrence];
    const match = atOccurrence && !result.has(atOccurrence) ? atOccurrence : candidates.find((o) => !result.has(o));
    if (match) result.add(match);
  }
  return result;
}

/**
 * Put the user's pre-takeover selections back (see `survivingSelection`). An
 * empty selection is restored as empty. A non-empty one of which nothing
 * survives leaves the client's own initialization standing, and nothing is
 * replayed. Then the checkboxes and radios the user changed get their state
 * back.
 */
function reselect(session: AdoptSession): void {
  for (const [select, snapshot] of session.selections) {
    if (!session.claimed.has(select) || !session.root.contains(select)) {
      session.touched.delete(select);
      continue;
    }
    if (snapshot.chosen.length === 0) {
      // Cleared on purpose: nothing selected, in a multiple and a single select.
      select.selectedIndex = -1;
      continue;
    }
    const keep = survivingSelection(select, snapshot);
    if (keep.size === 0) {
      session.touched.delete(select);
      continue;
    }
    if (select.multiple) for (const o of Array.from(select.options)) o.selected = keep.has(o);
    else (keep.values().next().value as HTMLOptionElement).selected = true;
  }
  // Unchecked first: checking a radio last unchecks the rest of its group.
  const live = Array.from(session.checks).filter(([el]) => session.claimed.has(el) && session.root.contains(el));
  for (const [el, checked] of live) if (!checked) el.checked = false;
  for (const [el, checked] of live) if (checked) el.checked = true;
}

function findDescriptor(proto: object | null, key: string): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  return undefined;
}

/**
 * One macrotask turn (every microtask queued before it has run). A
 * `MessageChannel` message where there is one: `setTimeout(0)` is clamped to
 * 1–4 ms, which would dominate a fast adoption.
 */
const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof MessageChannel === "function") {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    } else setTimeout(resolve, 0);
  });

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
    // A build that threw must not leave instance overrides behind.
    session.restore();
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
