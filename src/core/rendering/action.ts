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
  const handler = (e: Event) => {
    if (!element.contains(e.target as Node)) {
      callback();
    }
  };
  document.addEventListener("pointerdown", handler, true);
  return () => document.removeEventListener("pointerdown", handler, true);
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

/**
 * Fires a callback after a sustained press on the element.
 *
 * @example
 * ```ts
 * action(el, longPress, { duration: 800, callback: onLongPress });
 * ```
 */
export const longPress: ActionFn<LongPressOptions> = (element, options) => {
  const duration = options.duration ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = () => {
    timer = setTimeout(() => {
      options.callback();
      timer = null;
    }, duration);
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  element.addEventListener("pointerdown", start);
  element.addEventListener("pointerup", cancel);
  element.addEventListener("pointerleave", cancel);

  return () => {
    cancel();
    element.removeEventListener("pointerdown", start);
    element.removeEventListener("pointerup", cancel);
    element.removeEventListener("pointerleave", cancel);
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
  const handler = () => {
    const text = typeof getText === "function" ? getText() : (element.textContent ?? "");
    navigator.clipboard.writeText(text);
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

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
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
