import { bindAttribute } from "@sibujs/core/internal";
import { track } from "@sibujs/core/internal";

/**
 * Bind multiple reactive attributes to an element.
 * Each attribute value can be a static value or a reactive getter.
 * Returns a single teardown function that stops all bindings.
 */
export function bindAttrs(
  el: HTMLElement,
  attrs: Record<string, string | number | boolean | (() => string | number | boolean)>,
): () => void {
  const teardowns: Array<() => void> = [];

  for (const [attr, value] of Object.entries(attrs)) {
    if (typeof value === "function") {
      // Reactive getter — delegate to bindAttribute for tracking
      const teardown = bindAttribute(el, attr, value as () => unknown);
      teardowns.push(teardown);
    } else if (typeof value === "boolean") {
      // Static boolean — add or remove the attribute
      if (value) {
        el.setAttribute(attr, "");
      } else {
        el.removeAttribute(attr);
      }
    } else {
      // Static string or number — set once
      el.setAttribute(attr, String(value));
    }
  }

  // Combined teardown that cleans up all reactive bindings
  return () => {
    for (const td of teardowns) {
      td();
    }
  };
}

/**
 * Reactively toggle a boolean attribute (like disabled, readonly, hidden).
 * When the value is truthy the attribute is present (set to ""),
 * when falsy the attribute is removed entirely.
 * Returns a teardown function to stop reactive tracking.
 */
export function bindBoolAttr(el: HTMLElement, attr: string, getter: boolean | (() => boolean)): () => void {
  // Static boolean — apply once, no tracking needed
  if (typeof getter !== "function") {
    if (getter) {
      el.setAttribute(attr, "");
    } else {
      el.removeAttribute(attr);
    }
    return () => {};
  }

  // Reactive getter — track changes
  const reactiveGetter = getter as () => boolean;

  function commit() {
    let value: boolean;
    try {
      value = reactiveGetter();
    } catch {
      return;
    }

    if (value) {
      el.setAttribute(attr, "");
    } else {
      el.removeAttribute(attr);
    }
  }

  const teardown = track(commit);
  return teardown;
}

/**
 * Bind a data-* attribute reactively.
 * Shorthand for `bindAttribute(el, "data-<key>", getter)`.
 * Returns a teardown function to stop reactive tracking.
 */
export function bindData(el: HTMLElement, key: string, getter: string | (() => string)): () => void {
  const dataAttr = `data-${key}`;

  // Static value — set once, no tracking needed
  if (typeof getter !== "function") {
    el.setAttribute(dataAttr, String(getter));
    return () => {};
  }

  // Reactive getter — delegate to bindAttribute
  return bindAttribute(el, dataAttr, getter as () => unknown);
}
