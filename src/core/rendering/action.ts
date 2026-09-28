import { reportError } from "../errors";
import { registerDisposer } from "./dispose";

/**
 * An action is a reusable element-level behavior.
 * It receives the element and an optional parameter, and may return
 * a cleanup function that runs when the element is disposed.
 */
export type ActionFn<T = void> = (element: HTMLElement, param: T) => (() => void) | undefined;

// ─── Action registry ────────────────────────────────────────────────────────
//
// A name → action map so actions can be applied by string name (plugins,
// declarative/serialized usage) and discovered without importing each one. The
// map is shared across duplicate copies of this module via a globalThis registry
// (first-copy-wins, matching the reactive core), so an action registered in one
// copy is visible to `action(el, "name", ...)` resolved through another.
const ACTIONS_KEY = Symbol.for("sibujs.actions.v1");
const _actions: Map<string, ActionFn<unknown>> = ((
  globalThis as typeof globalThis & {
    [ACTIONS_KEY]?: Map<string, ActionFn<unknown>>;
  }
)[ACTIONS_KEY] ??= new Map<string, ActionFn<unknown>>());

/**
 * Register a reusable action under a name so it can be applied by string —
 * `action(el, "name", param)` — or looked up via {@link getAction}.
 *
 * Re-registering the same name overwrites the previous action. The built-in
 * actions (`clickOutside`, `longPress`, `copyOnClick`, `autoResize`,
 * `trapFocus`) are auto-registered under their export names.
 */
export function registerAction<T>(name: string, fn: ActionFn<T>): void {
  _actions.set(name, fn as ActionFn<unknown>);
}

/** Look up a registered action by name, or `undefined` if none is registered. */
export function getAction<T = unknown>(name: string): ActionFn<T> | undefined {
  return _actions.get(name) as ActionFn<T> | undefined;
}

/**
 * Attach a reusable action (element-level behavior) to an element.
 * The action's cleanup function (if returned) is automatically registered
 * via `registerDisposer`, so it runs when the element is disposed.
 *
 * The action may be passed directly, or by the name it was registered under
 * (see {@link registerAction}). Actions are composable — multiple can be
 * applied to the same element.
 *
 * @param element The target element
 * @param action The action function, or the name of a registered action
 * @param param Optional parameter passed to the action
 *
 * @example
 * ```ts
 * div({
 *   onElement: (el) => {
 *     action(el, clickOutside, () => setOpen(false));     // by reference
 *     action(el, "longPress", { duration: 500, callback: onLongPress }); // by name
 *   },
 * }, "Content");
 * ```
 */
export function action<T>(element: HTMLElement, action: ActionFn<T> | string, param: T): void;
// An action whose parameter is OPTIONAL may be applied without one. Without this
// overload the two-argument form demanded `ActionFn<void>`, so a first-party
// directive like `copyOnClick` — typed `ActionFn<(() => string) | undefined>`
// because its text getter is optional — could not be written as
// `action(el, copyOnClick)` even though that is its documented usage and exactly
// what the runtime does. Additive: it only widens what already compiled.
// (TYPE-009)
export function action<T>(element: HTMLElement, action: ActionFn<T | undefined> | string): void;
export function action(element: HTMLElement, action: ActionFn<void> | string): void;
export function action<T>(element: HTMLElement, action: ActionFn<T> | string, param?: T): void {
  const actionFn = typeof action === "string" ? getAction<T>(action) : action;
  if (!actionFn) {
    throw new Error(
      `[SibuJS] No action registered under the name "${action as string}". ` +
        "Register it with registerAction() before applying it by name.",
    );
  }
  const cleanup = actionFn(element, param as T);
  if (typeof cleanup === "function") {
    registerDisposer(element, cleanup);
  }
}

// ─── Built-in Actions ──────────────────────────────────────────────────────

/**
 * Fires a callback when the user clicks outside the element.
 * Useful for closing dropdowns, modals, and popovers.
 *
 * @example
 * ```ts
 * action(el, clickOutside, () => setOpen(false));
 * ```
 */
export const clickOutside: ActionFn<() => void> = (element, callback) => {
  // The element's own document, not the global one: an element hosted in an
  // iframe or another document receives its pointer events there, and the
  // global `document` never sees them. Captured once so cleanup removes the
  // listener from exactly the document it was added to, even if the element is
  // adopted elsewhere in between.
  const doc = element.ownerDocument;
  const handler = (e: Event) => {
    const target = e.target as Node | null;
    // `contains()` throws for a target that is not a Node (a window, or any
    // other EventTarget). `nodeType` asks "is this a Node" in any realm.
    if (!(typeof target?.nodeType === "number" && element.contains(target))) callback();
  };
  doc.addEventListener("pointerdown", handler, true);
  return () => doc.removeEventListener("pointerdown", handler, true);
};

/**
 * Options for the longPress action.
 */
export interface LongPressOptions {
  /** Duration in milliseconds before the press is considered "long". Default: 500 */
  duration?: number;
  /** Callback fired when the long press is detected. */
  callback: () => void;
}

/** Every way a press ends before it is long: release, leaving, or the platform taking the pointer over. */
const PRESS_END_EVENTS = ["pointerup", "pointerleave", "pointercancel"] as const;

/**
 * Fires a callback after a sustained press on the element.
 *
 * One press at a time, owned by the pointer that started it: only that
 * pointer's `pointerup`, `pointerleave` or `pointercancel` ends it, and another
 * pointer going down meanwhile is ignored. The same pointer going down again
 * restarts the press. Cleanup cancels a pending press, so the callback never
 * fires after the action is disposed.
 *
 * @example
 * ```ts
 * action(el, longPress, { duration: 800, callback: onLongPress });
 * ```
 */
export const longPress: ActionFn<LongPressOptions> = (element, options) => {
  const duration = options.duration ?? 500;
  // The ONE pending timer. A second `pointerdown` used to overwrite this
  // handle, leaving the first timeout unreachable by `cancel()` — it fired
  // after release, and even after the action was disposed.
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The pointer that owns the pending press. `undefined` is a valid owner: an
  // event without a `pointerId` (a synthetic `Event`) is one anonymous pointer.
  let owner: number | undefined;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const start = (e: Event) => {
    const id = (e as PointerEvent).pointerId;
    // A second pointer while a press is pending — another finger, a pen next to
    // a mouse — neither starts a press of its own nor disturbs this one.
    if (timer !== null && id !== owner) return;
    cancel();
    owner = id;
    timer = setTimeout(() => {
      timer = null;
      options.callback();
    }, duration);
  };

  const end = (e: Event) => {
    if (timer !== null && (e as PointerEvent).pointerId === owner) cancel();
  };

  element.addEventListener("pointerdown", start);
  for (const type of PRESS_END_EVENTS) element.addEventListener(type, end);

  return () => {
    cancel();
    element.removeEventListener("pointerdown", start);
    for (const type of PRESS_END_EVENTS) element.removeEventListener(type, end);
  };
};

/**
 * Copies the element's textContent to the clipboard on click.
 * Optionally accepts a custom getter for the text to copy.
 *
 * @example
 * ```ts
 * // Copy element text
 * action(el, copyOnClick);
 *
 * // Copy custom value
 * action(el, copyOnClick, () => secretToken());
 * ```
 */
export const copyOnClick: ActionFn<(() => string) | undefined> = (element, getText) => {
  // A failure — no Clipboard API (insecure context: the call below throws a
  // TypeError), a throwing getter, or a rejected write (permission denied) — is
  // reported with the element instead of escaping as an uncaught error or an
  // unhandled rejection.
  const report = (error: unknown) => reportError(error, { phase: "async", name: "copyOnClick", node: element });
  const handler = () => {
    try {
      const text = typeof getText === "function" ? getText() : (element.textContent ?? "");
      Promise.resolve(navigator.clipboard.writeText(text)).catch(report);
    } catch (error) {
      report(error);
    }
  };
  element.addEventListener("click", handler);
  return () => element.removeEventListener("click", handler);
};

/**
 * Auto-resizes a textarea to fit its content.
 * Adjusts height on input and on initial attach.
 *
 * @example
 * ```ts
 * const ta = textarea({ placeholder: "Type here..." });
 * action(ta, autoResize);
 * ```
 */
export const autoResize: ActionFn<void> = (element) => {
  const resize = () => {
    element.style.overflow = "hidden";
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  };
  resize();
  element.addEventListener("input", resize);
  return () => element.removeEventListener("input", resize);
};

/**
 * Traps keyboard focus within the element (Tab and Shift+Tab cycle).
 * Essential for accessible modals and dialogs.
 *
 * @example
 * ```ts
 * action(el, trapFocus);
 * ```
 */
export const trapFocus: ActionFn<void> = (element) => {
  const focusable =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;

    const elements = Array.from(element.querySelectorAll<HTMLElement>(focusable));
    if (elements.length === 0) return;

    const first = elements[0];
    const last = elements[elements.length - 1];
    // The focused element of the document the trap lives in. The global
    // `document.activeElement` is another document's focus when the element
    // is hosted in an iframe, so the wrap-around never triggered there.
    const active = element.ownerDocument.activeElement;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  element.addEventListener("keydown", handler);
  return () => element.removeEventListener("keydown", handler);
};

// ─── Built-in registration ──────────────────────────────────────────────────
//
// Make the built-ins discoverable by name so `action(el, "clickOutside", …)`
// works out of the box and plugins can look them up via getAction().
registerAction("clickOutside", clickOutside);
registerAction("longPress", longPress);
registerAction("copyOnClick", copyOnClick);
registerAction("autoResize", autoResize);
registerAction("trapFocus", trapFocus);
