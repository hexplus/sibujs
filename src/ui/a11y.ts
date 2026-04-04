import { signal } from "../core/signals/signal";
import { track } from "../reactivity/track";

// ============================================================================
// ACCESSIBILITY
// ============================================================================

/**
 * aria applies reactive ARIA attributes to an element.
 */
export function aria(element: HTMLElement, attrs: Record<string, string | boolean | (() => string | boolean)>): void {
  for (const [key, value] of Object.entries(attrs)) {
    const ariaKey = key.startsWith("aria-") ? key : `aria-${key}`;

    if (typeof value === "function") {
      const getter = value as () => string | boolean;
      track(() => {
        element.setAttribute(ariaKey, String(getter()));
      });
    } else {
      element.setAttribute(ariaKey, String(value));
    }
  }
}

/**
 * focus manages focus state for an element.
 */
export function focus(): {
  isFocused: () => boolean;
  focus: () => void;
  blur: () => void;
  bind: (element: HTMLElement) => void;
} {
  const [isFocused, setIsFocused] = signal(false);
  let currentElement: HTMLElement | null = null;

  function bind(element: HTMLElement): void {
    currentElement = element;
    element.addEventListener("focus", () => setIsFocused(true));
    element.addEventListener("blur", () => setIsFocused(false));
  }

  function focus(): void {
    currentElement?.focus();
  }

  function blur(): void {
    currentElement?.blur();
  }

  return { isFocused, focus, blur, bind };
}

/**
 * FocusTrap traps focus within a container element.
 * Tab cycling stays inside the container.
 */
export function FocusTrap(
  nodes: HTMLElement,
  options: { autoFocus?: boolean; restoreFocus?: boolean } = {},
): HTMLElement {
  const container = document.createElement("div");
  container.setAttribute("data-sibu-focus-trap", "true");
  container.appendChild(nodes);

  const previouslyFocused = document.activeElement as HTMLElement;

  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;

    const focusable = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  if (options.autoFocus !== false) {
    queueMicrotask(() => {
      const first = container.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    });
  }

  // Restore focus on removal
  if (options.restoreFocus !== false) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const removed of Array.from(mutation.removedNodes)) {
          if (removed === container || removed.contains(container)) {
            previouslyFocused?.focus();
            observer.disconnect();
            return;
          }
        }
      }
    });

    queueMicrotask(() => {
      if (container.parentNode) {
        observer.observe(container.parentNode, { childList: true });
      }
    });
  }

  return container;
}

/**
 * hotkey registers a keyboard shortcut handler.
 * Returns a cleanup function.
 *
 * Supports two calling styles:
 * - String combo:   hotkey("ctrl+shift+z", handler)
 * - Explicit flags: hotkey("z", handler, { ctrl: true, shift: true })
 */
export function hotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  options: {
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    meta?: boolean;
    global?: boolean;
    preventDefault?: boolean;
  } = {},
): () => void {
  let key = combo;
  let needCtrl = options.ctrl ?? false;
  let needShift = options.shift ?? false;
  let needAlt = options.alt ?? false;
  let needMeta = options.meta ?? false;

  // Parse "ctrl+shift+z" combo syntax
  if (combo.includes("+")) {
    const parts = combo.toLowerCase().split("+");
    key = parts[parts.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i];
      if (mod === "ctrl" || mod === "control") needCtrl = true;
      else if (mod === "shift") needShift = true;
      else if (mod === "alt") needAlt = true;
      else if (mod === "meta" || mod === "cmd" || mod === "command") needMeta = true;
    }
  }

  const listener = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key.toLowerCase() !== key.toLowerCase()) return;
    if (needCtrl !== ke.ctrlKey) return;
    if (needShift !== ke.shiftKey) return;
    if (needAlt !== ke.altKey) return;
    if (needMeta !== ke.metaKey) return;

    if (options.preventDefault) ke.preventDefault();
    handler(ke);
  };

  document.addEventListener("keydown", listener);

  return () => document.removeEventListener("keydown", listener);
}

/**
 * announce creates a screen reader announcement using ARIA live regions.
 */
export function announce(message: string, priority: "polite" | "assertive" = "polite"): void {
  let region = document.getElementById(`sibu-announce-${priority}`);

  if (!region) {
    region = document.createElement("div");
    region.id = `sibu-announce-${priority}`;
    region.setAttribute("aria-live", priority);
    region.setAttribute("aria-atomic", "true");
    region.setAttribute("role", priority === "assertive" ? "alert" : "status");
    region.style.cssText =
      "position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;";
    document.body.appendChild(region);
  }

  // Clear and set to trigger announcement
  region.textContent = "";
  requestAnimationFrame(() => {
    if (region) region.textContent = message;
  });
}
