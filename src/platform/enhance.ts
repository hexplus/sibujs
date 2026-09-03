// ---------------------------------------------------------------------------
// enhance() — attach fine-grained reactivity to existing (server-rendered) DOM
// without re-rendering it.
//
// This is the third rendering mode, and the one nobody else does without a
// build step:
//   - mount(component, container)        → render a fresh tree
//   - hydrate(component, container)       → own + replace server markup
//   - enhance(target, setup)              → ATTACH to server markup in place
//
// `enhance` never recreates static DOM. It binds signals/effects to nodes the
// server already sent, drives only the dynamic bits (text/attrs/classes/events),
// and ties every binding to disposal — so static content never re-paints.
// ---------------------------------------------------------------------------

import { devAssert, isDev } from "../core/dev";
import {
  MAX_DRAIN_TEARDOWNS,
  registerDisposer,
  reportDrainRunaway,
  unregisterDisposer,
} from "../core/rendering/dispose";
import { isSSR } from "../core/ssr-context";
import { reactiveBinding } from "../reactivity/track";
import { setSafeAttribute } from "../utils/setSafeAttribute";

/** Attribute marking a root that *currently* owns an active enhancement.
 *  Added on commit, removed on disposal — see the lifecycle notes on
 *  {@link enhance}. */
const ENHANCED_ATTR = "data-sibu-enhanced";

/**
 * Which enhancement generation currently owns a root.
 *
 * A disposer releases the marker only while its own generation still holds it,
 * so a stale disposer replayed after the root has been enhanced again cannot
 * strip the newer generation's claim (`enhance → dispose → enhance → dispose#1`).
 */
const enhancementOwner = new WeakMap<HTMLElement, symbol>();

/**
 * Drain a teardown list exactly once per entry, isolating failures.
 *
 * A broken teardown must never abort the rest of the unwind, and a teardown may
 * legitimately register another (`ctx.cleanup` stays reachable from inside one).
 * The list is therefore drained **until it is stable, or until
 * {@link MAX_DRAIN_TEARDOWNS} is reached** — a safety ceiling on total teardown
 * executions, not on iterations over the list. Finite chains of ordinary
 * practical depth complete; work is never abandoned merely for crossing an
 * internal boundary. Splicing before running is what makes it idempotent and
 * reentrancy-safe — an entry is off the list before it executes, so it runs at
 * most once.
 *
 * The ceiling is an **absolute work bound**, not a recursion detector: it
 * primarily catches cleanup production that does not terminate, but an
 * exceptionally large finite chain reaches it too. Either way it is
 * **reported** — this queue is local to one enhancement, so anything still on
 * it once this returns is unreachable forever; the remainder is reported and
 * then cleared deliberately rather than left to vanish. `dispose()` differs
 * deliberately, restoring its remainder because a node-keyed queue stays
 * reachable through a later `dispose(node)`.
 *
 * Batch-splicing keeps the normal case O(number of teardowns); no per-entry
 * `shift()`.
 */
function drainTeardowns(teardowns: Array<() => void>, label: string): void {
  let executed = 0;
  while (teardowns.length > 0) {
    const batch = teardowns.splice(0);
    for (let i = 0; i < batch.length; i++) {
      if (executed >= MAX_DRAIN_TEARDOWNS) {
        const remaining = batch.length - i + teardowns.length;
        teardowns.length = 0;
        reportDrainRunaway(label, executed, remaining);
        return;
      }
      executed++;
      try {
        batch[i]();
      } catch (err) {
        if (typeof console !== "undefined") console.error(`[SibuJS ${label}] teardown error:`, err);
      }
    }
  }
}

/** Event handlers for {@link EachBindings}, typed per event name. */
export type EachEventBindings = {
  [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K], el: HTMLElement) => void;
};

/**
 * What {@link EnhanceContext.each} attaches to one element.
 *
 * Every field maps one-to-one onto an existing `ctx.*` helper and is committed
 * through it — this is a shorthand for calls you could write by hand, not a
 * template language and not a second binding engine. There is no expression
 * parsing, no string interpolation and no `eval`: every value is a plain
 * function you wrote, so it stays CSP-safe and fully type-checked.
 *
 * Anything not covered here (two-way `model()`, listener options, a nested
 * `enhance`) is written imperatively in the same callback — it receives the
 * element, so `ctx.model(el, …)` beside a returned descriptor is normal.
 */
export interface EachBindings {
  /** Reactive `textContent` — same as `ctx.text(el, value)`. */
  text?: () => unknown;
  /** Reactive attributes by name — same as `ctx.attr(el, name, value)`. */
  attr?: Record<string, () => unknown>;
  /** Reactive class toggles by class name — same as `ctx.classed(el, name, on)`. */
  class?: Record<string, () => boolean>;
  /** Reactive visibility — same as `ctx.show(el, when)`. */
  show?: () => boolean;
  /** Event listeners by event name — same as `ctx.on(el, event, handler)`. */
  on?: EachEventBindings;
  /** Per-element teardown, run with the rest of the enhancement's cleanups. */
  cleanup?: () => void;
}

const EACH_KEYS = ["text", "attr", "class", "show", "on", "cleanup"] as const;

/**
 * Helpers handed to an `enhance` setup. Every binding is fine-grained (its own
 * effect) and auto-disposed when the root element (or the returned dispose) is
 * torn down.
 *
 * Target resolution for every helper:
 *   - `"@name"`  → a descendant marked `data-ref="name"` (the ergonomic form).
 *   - any other string → a raw CSS selector, queried within the root.
 *   - an `Element` → used as-is.
 *   - `null` / omitted (where allowed) → the root element itself.
 */
export interface EnhanceContext {
  /** The enhanced root element (the server-rendered node). */
  root: HTMLElement;
  /** First descendant matching a `@ref`/selector (or the root for `null`). */
  ref<T extends Element = HTMLElement>(target: string | null): T | null;
  /** All descendants matching a `@ref`/selector. */
  refs<T extends Element = HTMLElement>(target: string): T[];
  /** Attach an auto-removed event listener to a target (root if `null`). */
  on<K extends keyof HTMLElementEventMap>(
    target: string | Element | null,
    event: K,
    handler: (event: HTMLElementEventMap[K], el: HTMLElement) => void,
    options?: AddEventListenerOptions,
  ): void;
  /** Reactively drive `textContent` of an existing node. */
  text(target: string | Element | null, value: () => unknown): void;
  /** Reactively drive an attribute; a `null`/`false`/`undefined` value removes it. */
  attr(target: string | Element | null, name: string, value: () => unknown): void;
  /** Reactively toggle a class on a node. */
  classed(target: string | Element | null, name: string, on: () => boolean): void;
  /** Reactively toggle visibility (sets `display:none` when `false`). */
  show(target: string | Element | null, when: () => boolean): void;
  /** Two-way bind a form control to a `[get, set]` signal tuple. */
  model<T>(target: string | Element, state: readonly [() => T, (value: T) => void], options?: { event?: string }): void;
  /**
   * Bind a set of elements the server already rendered — a board, a table, a
   * keyboard, a timeline, a legend — one descriptor at a time.
   *
   * The callback receives each element and its index and returns what to
   * attach; every field is committed through the matching `ctx.*` helper, so
   * ownership, disposal, write elision, attribute sanitization and error
   * routing are byte-for-byte the same as writing the calls out by hand. No
   * element is created, replaced, moved or re-parented — node identity is
   * preserved, which is the entire point of enhancing existing markup.
   *
   * ```ts
   * ctx.each<HTMLButtonElement>("@square", (el) => {
   *   const square = el.dataset.square as Square;
   *   return {
   *     text: () => pieceAt(square),
   *     class: { selected: () => selected() === square },
   *     attr: { "aria-label": () => describe(square) },
   *     on: { click: () => choose(square) },
   *   };
   * });
   * ```
   *
   * The callback may also return nothing and wire the element imperatively —
   * `ctx.model(el, …)`, `ctx.on(el, "click", h, { passive: true })` — for the
   * cases the descriptor deliberately does not cover.
   *
   * Zero matches is a silent no-op. Calling `each` twice over the same
   * elements creates two independent sets of bindings, exactly as calling
   * `ctx.text()` twice on one node does; the helper is sugar over those calls
   * and does not track what a previous call attached.
   *
   * @param target A `@ref`/CSS selector resolved with {@link EnhanceContext.refs},
   *   or any iterable of elements (an array, a `NodeList`, an `HTMLCollection`).
   * @param describe Called once per element, in document order.
   */
  each<T extends Element = HTMLElement>(
    target: string | Iterable<Element>,
    // biome-ignore lint/suspicious/noConfusingVoidType: intentional "a descriptor, or nothing" return — the callback may wire the element imperatively instead. Mirrors EnhanceSetup.
    describe: (element: T, index: number) => EachBindings | void,
  ): void;
  /** Register arbitrary teardown to run on disposal. */
  cleanup(fn: () => void): void;
}

/** A setup function for `enhance` — wire reactivity, optionally return cleanup.
 *  The `void | (() => void)` shape mirrors `useEffect`'s "return a teardown, or
 *  nothing". */
// biome-ignore lint/suspicious/noConfusingVoidType: intentional "cleanup or nothing" return, like an effect.
export type EnhanceSetup = (ctx: EnhanceContext) => void | (() => void);

function resolveTarget(root: HTMLElement, target: string | Element | null): HTMLElement | null {
  if (target == null) return root;
  if (typeof target !== "string") return target as HTMLElement;
  const selector = target.startsWith("@") ? `[data-ref="${target.slice(1)}"]` : target;
  // `:scope` keeps the selector rooted at the element and lets the root itself
  // match when relevant; fall back for environments without `:scope`.
  try {
    return root.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

/**
 * Create one fine-grained binding for a node.
 *
 * Every reactive helper on the {@link EnhanceContext} goes through here, so
 * enhancement bindings are indistinguishable from the runtime's other DOM
 * bindings (`bindTextNode`, `bindAttribute`, the tag factory's class/style
 * writers): the subscriber is stamped `_errorPhase: "binding"` and carries the
 * node it owns.
 *
 * That metadata is only ever read on the failure path, and it is the whole
 * reason this is not a plain `effect()`. A binding that throws on a LATER run
 * is reported by the notification drain, which has no other way to know it was
 * looking at a DOM binding or which node it belonged to — and `reportError()`
 * offers a node's enclosing `ErrorBoundary` first refusal, so an enhancement
 * binding with no node could never reach a boundary at all.
 *
 * SSR parity with `effect()` is deliberate: side effects do not run on the
 * server, so a binding created during SSR is inert and its disposer is a no-op.
 */
function bindNode(el: HTMLElement, commit: () => void): () => void {
  if (isSSR()) return () => {};
  return reactiveBinding(commit, el);
}

function readControlValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number" || el.type === "range") return el.value === "" ? null : Number(el.value);
  }
  if (el instanceof HTMLSelectElement && el.multiple) {
    return Array.from(el.selectedOptions, (o) => o.value);
  }
  return el.value;
}

function writeControlValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: unknown): void {
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.checked = Boolean(value);
    return;
  }
  if (el instanceof HTMLSelectElement && el.multiple) {
    const selected = Array.isArray(value) ? value.map(String) : [];
    for (const opt of Array.from(el.options)) opt.selected = selected.includes(opt.value);
    return;
  }
  const next = value == null ? "" : String(value);
  if (el.value !== next) el.value = next;
}

/**
 * Commit one {@link EachBindings} descriptor through the ordinary context
 * helpers.
 *
 * Routing everything back through `ctx` is what keeps `each` sugar rather than
 * a second implementation: there is no binding path here that `ctx.text` /
 * `ctx.attr` / `ctx.classed` / `ctx.show` / `ctx.on` do not already own, so
 * error metadata, sanitization, write elision and teardown registration cannot
 * drift between the two ways of writing the same thing.
 *
 * Shape mistakes are caught in development with the element's index and the
 * offending key, because a descriptor is data and a typo in it would otherwise
 * fail silently (an unknown key) or as an opaque `x is not a function` on a
 * later drain (a value that is not a getter). The assertion throws inside
 * `setup`, so `enhance`'s transaction rolls the whole enhancement back — the
 * element is left exactly as the server sent it.
 */
function applyEachBindings(ctx: EnhanceContext, el: HTMLElement, spec: EachBindings, index: number): void {
  const where = `ctx.each[${index}]`;
  if (isDev()) {
    for (const key of Object.keys(spec)) {
      devAssert(
        (EACH_KEYS as readonly string[]).includes(key),
        `${where}: unknown binding "${key}". Expected one of: ${EACH_KEYS.join(", ")}.`,
      );
    }
  }

  if (spec.text !== undefined) {
    devAssert(typeof spec.text === "function", `${where}: "text" must be a function returning the value.`);
    ctx.text(el, spec.text);
  }
  if (spec.attr !== undefined) {
    for (const name of Object.keys(spec.attr)) {
      const value = spec.attr[name];
      devAssert(typeof value === "function", `${where}: attr["${name}"] must be a function returning the value.`);
      ctx.attr(el, name, value);
    }
  }
  if (spec.class !== undefined) {
    for (const name of Object.keys(spec.class)) {
      const on = spec.class[name];
      devAssert(typeof on === "function", `${where}: class["${name}"] must be a function returning a boolean.`);
      ctx.classed(el, name, on);
    }
  }
  if (spec.show !== undefined) {
    devAssert(typeof spec.show === "function", `${where}: "show" must be a function returning a boolean.`);
    ctx.show(el, spec.show);
  }
  if (spec.on !== undefined) {
    for (const event of Object.keys(spec.on) as Array<keyof HTMLElementEventMap>) {
      const handler = spec.on[event];
      devAssert(typeof handler === "function", `${where}: on["${String(event)}"] must be a function.`);
      ctx.on(el, event, handler as (e: HTMLElementEventMap[typeof event], el: HTMLElement) => void);
    }
  }
  if (spec.cleanup !== undefined) {
    devAssert(typeof spec.cleanup === "function", `${where}: "cleanup" must be a function.`);
    ctx.cleanup(spec.cleanup);
  }
}

/**
 * Attach reactivity to an existing element (typically server-rendered) without
 * replacing it. Returns a dispose function; disposal is also wired to the
 * element, so removing its subtree cleans everything up.
 *
 * **Setup is a transaction.** If `setup` throws, every binding, listener and
 * cleanup it registered through the {@link EnhanceContext} is torn down and the
 * original error is rethrown unchanged — the element is left exactly as
 * unenhanced as it started, so a retry is legal. The rollback covers
 * framework-owned resources only (`ctx.on`, `ctx.text`, `ctx.attr`,
 * `ctx.classed`, `ctx.show`, `ctx.model`, `ctx.cleanup`, and a cleanup returned
 * from setup); work the setup performed outside those helpers — `innerHTML`
 * writes, network calls, global mutation — cannot be reversed generically, so
 * register its undo with `ctx.cleanup()` as you go.
 *
 * **Ownership.** A successfully enhanced root is marked
 * `data-sibu-enhanced="true"`; disposal removes it. The marker tracks *current*
 * ownership rather than history, so a **disposed root can be enhanced again**,
 * while enhancing a root that is still active is refused (dev-warns) to prevent
 * two competing sets of bindings. See `docs/architecture/enhancement-lifecycle.md`.
 *
 * @param target An `Element` or a CSS selector resolved against `document`
 *   (the first match is used; see {@link enhanceAll} for many).
 * @param setup  Wires reactivity via the {@link EnhanceContext}.
 * @throws Whatever `setup` throws, after rolling its resources back.
 *
 * @example
 * ```ts
 * // server HTML: <div data-counter><b data-ref="n">0</b><button data-ref="inc">+1</button></div>
 * const [n, setN] = signal(0);
 * enhance("[data-counter]", (ctx) => {
 *   ctx.text("@n", () => n());
 *   ctx.on("@inc", "click", () => setN((v) => v + 1));
 * });
 * ```
 */
export function enhance(target: Element | string, setup: EnhanceSetup): () => void {
  const root =
    typeof target === "string"
      ? typeof document !== "undefined"
        ? document.querySelector<HTMLElement>(target)
        : null
      : (target as HTMLElement);

  if (!root) {
    if (typeof console !== "undefined") {
      console.warn(`[SibuJS enhance] no element matched ${JSON.stringify(target)} — nothing enhanced.`);
    }
    return () => {};
  }

  // Idempotency: enhancing a root that *currently* owns an enhancement would
  // double-wire it (two sets of listeners/effects, ambiguous ownership). Refuse
  // and warn in dev. The marker tracks live ownership, not history, so a root
  // whose enhancement has been disposed is enhanceable again.
  if (root.getAttribute(ENHANCED_ATTR) === "true") {
    if (isDev() && typeof console !== "undefined") {
      console.warn("[SibuJS enhance] element is already enhanced; ignoring re-enhance.", root);
    }
    // Inert: this call owns nothing, so its disposer must not release the
    // marker (or anything else) belonging to the active enhancement.
    return () => {};
  }

  const teardowns: Array<() => void> = [];
  const owner = Symbol("sibujs.enhance");
  let disposed = false;

  const bind = (target_: string | Element | null, fn: (el: HTMLElement) => void): void => {
    const el = resolveTarget(root, target_);
    if (!el) {
      if (typeof console !== "undefined") {
        console.warn(`[SibuJS enhance] target ${JSON.stringify(target_)} not found under`, root);
      }
      return;
    }
    fn(el);
  };

  const ctx: EnhanceContext = {
    root,
    ref: <T extends Element = HTMLElement>(t: string | null) => resolveTarget(root, t) as unknown as T | null,
    refs: <T extends Element = HTMLElement>(t: string) => {
      const selector = t.startsWith("@") ? `[data-ref="${t.slice(1)}"]` : t;
      try {
        return Array.from(root.querySelectorAll<Element>(selector)) as unknown as T[];
      } catch {
        return [];
      }
    },
    on: (t, event, handler, options) => {
      bind(t, (el) => {
        const wrapped = (e: Event) => handler(e as never, el);
        el.addEventListener(event, wrapped as EventListener, options);
        teardowns.push(() => el.removeEventListener(event, wrapped as EventListener, options));
      });
    },
    text: (t, value) => {
      bind(t, (el) => {
        teardowns.push(
          bindNode(el, () => {
            const v = value();
            const next = v == null ? "" : String(v);
            // Skip no-op writes: when the value already matches the server
            // markup (or hasn't changed), the static node is never touched — no
            // re-paint, no flash.
            if (el.textContent !== next) el.textContent = next;
          }),
        );
      });
    },
    attr: (t, name, value) => {
      bind(t, (el) => {
        teardowns.push(
          bindNode(el, () => {
            const v = value();
            // null/undefined removes the attribute; everything else (including
            // booleans) is serialized literally — so `aria-expanded` reads
            // "true"/"false" instead of being dropped. For boolean HTML
            // attributes (disabled, hidden…), return `cond || null` to get
            // presence/absence.
            const next = v == null ? null : String(v);

            // Committed through the shared attribute primitive, like every
            // other attribute writer. `attr()`'s VALUE is a runtime getter —
            // the same trust level as a `bindAttribute` getter — so a raw
            // `setAttribute` here made progressive enhancement the one public
            // path where `javascript:` href/src, an unsafe `style` declaration
            // list, or an `on*` handler string still reached the DOM.
            //
            // There is deliberately NO pre-write comparison here. This helper
            // attaches to DOM that already exists, so comparing the raw desired
            // value against the raw attribute skipped the sanitizer in exactly
            // the case that matters: server markup already holding the same
            // dangerous string. Write elision now lives inside the primitive,
            // where it compares the POST-POLICY result and is therefore safe.
            //
            // `syncValueProperty: false` keeps this an ATTRIBUTE writer, as its
            // name and existing behaviour promise: `attr(el, "value", …)` must
            // set the content attribute, not the IDL property.
            setSafeAttribute(el, name, next, { syncValueProperty: false, label: "enhance attr()" });
          }),
        );
      });
    },
    classed: (t, name, on) => {
      bind(t, (el) => {
        teardowns.push(
          bindNode(el, () => {
            el.classList.toggle(name, Boolean(on()));
          }),
        );
      });
    },
    show: (t, when) => {
      bind(t, (el) => {
        // Toggle the standard `hidden` property — this both reveals an element
        // the server rendered with the `hidden` attribute (the common
        // progressive-enhancement case) and hides one that wasn't. Using
        // `style.display` alone could not override a server `hidden` attribute.
        const prevHidden = el.hidden;
        teardowns.push(
          bindNode(el, () => {
            el.hidden = !when();
          }),
        );
        teardowns.push(() => {
          el.hidden = prevHidden;
        });
      });
    },
    model: (t, state, options) => {
      bind(t, (el) => {
        const control = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const [get, set] = state;
        const evt =
          options?.event ??
          (control instanceof HTMLSelectElement ||
          (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio"))
            ? "change"
            : "input");
        // Signal → control (writeControlValue skips no-op writes internally).
        teardowns.push(
          bindNode(el, () => {
            writeControlValue(control, get());
          }),
        );
        // Control → signal
        const onInput = () => set(readControlValue(control) as never);
        control.addEventListener(evt, onInput);
        teardowns.push(() => control.removeEventListener(evt, onInput));
      });
    },
    each: (target_, describe) => {
      devAssert(typeof describe === "function", "ctx.each: second argument must be a function.");
      const elements =
        typeof target_ === "string" ? ctx.refs<HTMLElement>(target_) : (Array.from(target_) as HTMLElement[]);
      // Zero matches is a legitimate state (an empty list, a table with no
      // rows), so it is a silent no-op rather than a warning.
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const spec = describe(el as never, i);
        if (spec == null) continue;
        applyEachBindings(ctx, el, spec, i);
      }
    },
    cleanup: (fn) => {
      teardowns.push(fn);
    },
  };

  // Setup is a transaction over framework-owned resources. If it throws, every
  // binding/listener/cleanup registered through `ctx` before the throw is torn
  // down and the original error is rethrown untouched — the root is left exactly
  // as unenhanced as it started, so a retry is legal. Side effects the setup
  // performed *outside* SibuJS (innerHTML writes, network calls, globals) are
  // not framework-owned and are not reversed; see docs/architecture/enhancement-lifecycle.md.
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors EnhanceSetup's "cleanup or nothing" return.
  let extra: void | (() => void);
  try {
    extra = setup(ctx);
  } catch (err) {
    drainTeardowns(teardowns, "enhance");
    throw err;
  }
  if (typeof extra === "function") teardowns.push(extra);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Release ownership before running teardowns: a teardown may legitimately
    // re-enhance the root, and it must not find a stale marker in its way.
    if (enhancementOwner.get(root) === owner) {
      enhancementOwner.delete(root);
      root.removeAttribute(ENHANCED_ATTR);
    }
    // The node-level entry is dead once drained; drop it so repeated
    // enhance/dispose cycles on a long-lived root don't accumulate closures.
    unregisterDisposer(root, dispose);
    drainTeardowns(teardowns, "enhance");
  };

  // Commit. Ownership is recorded and only *then* is the root marked, so the
  // marker is never observable for an enhancement that did not complete.
  // Tie cleanup to the element too, so removing its subtree disposes the bindings.
  registerDisposer(root, dispose);
  enhancementOwner.set(root, owner);
  root.setAttribute(ENHANCED_ATTR, "true");

  return dispose;
}

/**
 * Enhance every element matching a selector. Returns a single dispose that
 * tears down all of them.
 *
 * The whole collection is one transaction: if any element's setup throws, the
 * elements already enhanced are rolled back (newest first, mirroring stack
 * unwinding) and the original error is rethrown. A caller that never received
 * the aggregate disposer is therefore never left holding live enhancements it
 * has no way to release. A teardown that fails during that rollback is reported
 * and skipped — it neither aborts the remaining rollback nor replaces the
 * original setup error.
 *
 * The returned disposer is idempotent, and the collection may be enhanced again
 * afterwards (see {@link enhance} on marker lifetime).
 *
 * @throws Whatever the failing element's setup threw, after rolling back.
 */
export function enhanceAll(selector: string, setup: EnhanceSetup): () => void {
  if (typeof document === "undefined") return () => {};
  const disposers: Array<() => void> = [];
  try {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      disposers.push(enhance(el, setup));
    }
  } catch (err) {
    // The failing element already rolled itself back inside enhance(); unwind
    // the committed ones. A broken teardown must neither abort the remaining
    // rollback nor replace the original setup error.
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        disposers[i]();
      } catch (rollbackErr) {
        if (typeof console !== "undefined") console.error("[SibuJS enhanceAll] rollback error:", rollbackErr);
      }
    }
    disposers.length = 0;
    throw err;
  }
  return () => {
    for (const d of disposers.splice(0)) d();
  };
}
