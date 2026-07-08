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

import { isDev } from "../core/dev";
import { registerDisposer } from "../core/rendering/dispose";
import { effect } from "../core/signals/effect";

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
 * Attach reactivity to an existing element (typically server-rendered) without
 * replacing it. Returns a dispose function; disposal is also wired to the
 * element, so removing its subtree cleans everything up.
 *
 * @param target An `Element` or a CSS selector resolved against `document`
 *   (the first match is used; see {@link enhanceAll} for many).
 * @param setup  Wires reactivity via the {@link EnhanceContext}.
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

  // Idempotency: enhancing the same element twice would double-wire it (two sets
  // of listeners/effects). Refuse and warn in dev.
  if (root.getAttribute("data-sibu-enhanced") === "true") {
    if (isDev() && typeof console !== "undefined") {
      console.warn("[SibuJS enhance] element is already enhanced; ignoring re-enhance.", root);
    }
    return () => {};
  }

  const teardowns: Array<() => void> = [];
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
          effect(() => {
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
          effect(() => {
            const v = value();
            // null/undefined removes the attribute; everything else (including
            // booleans) is serialized literally — so `aria-expanded` reads
            // "true"/"false" instead of being dropped. For boolean HTML
            // attributes (disabled, hidden…), return `cond || null` to get
            // presence/absence. Writes are skipped when nothing changed.
            const next = v == null ? null : String(v);
            if (next === null) {
              if (el.hasAttribute(name)) el.removeAttribute(name);
            } else if (el.getAttribute(name) !== next) {
              el.setAttribute(name, next);
            }
          }),
        );
      });
    },
    classed: (t, name, on) => {
      bind(t, (el) => {
        teardowns.push(
          effect(() => {
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
          effect(() => {
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
          effect(() => {
            writeControlValue(control, get());
          }),
        );
        // Control → signal
        const onInput = () => set(readControlValue(control) as never);
        control.addEventListener(evt, onInput);
        teardowns.push(() => control.removeEventListener(evt, onInput));
      });
    },
    cleanup: (fn) => {
      teardowns.push(fn);
    },
  };

  const extra = setup(ctx);
  if (typeof extra === "function") teardowns.push(extra);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const fn of teardowns.splice(0)) {
      try {
        fn();
      } catch (err) {
        if (typeof console !== "undefined") console.error("[SibuJS enhance] teardown error:", err);
      }
    }
  };

  // Tie cleanup to the element so removing its subtree disposes the bindings.
  registerDisposer(root, dispose);
  // Mark for tooling / idempotency in island bootstrapping.
  root.setAttribute("data-sibu-enhanced", "true");

  return dispose;
}

/**
 * Enhance every element matching a selector. Returns a single dispose that
 * tears down all of them.
 */
export function enhanceAll(selector: string, setup: EnhanceSetup): () => void {
  if (typeof document === "undefined") return () => {};
  const disposers = Array.from(document.querySelectorAll<HTMLElement>(selector)).map((el) => enhance(el, setup));
  return () => {
    for (const d of disposers) d();
  };
}
