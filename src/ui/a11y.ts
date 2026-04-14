import { registerDisposer } from "../core/rendering/dispose";
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
  bind: (element: HTMLElement) => () => void;
} {
  const [isFocused, setIsFocused] = signal(false);
  let currentElement: HTMLElement | null = null;

  /**
   * Attach focus/blur listeners to the given element. Returns a `dispose()`
   * function that removes the listeners. The returned disposer is also
   * registered with the element so SPA unmounts clean it up automatically.
   */
  function bind(element: HTMLElement): () => void {
    currentElement = element;
    const onFocus = () => setIsFocused(true);
    const onBlur = () => setIsFocused(false);
    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", onBlur);

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      element.removeEventListener("focus", onFocus);
      element.removeEventListener("blur", onBlur);
      if (currentElement === element) currentElement = null;
    };
    registerDisposer(element, dispose);
    return dispose;
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

  // Base selector — narrowed further by tree-walker filters below.
  const FOCUSABLE_SELECTOR =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]';

  function isEffectivelyVisible(el: HTMLElement): boolean {
    // Walk ancestors to detect hidden/inert/aria-hidden/display:none.
    let node: HTMLElement | null = el;
    while (node) {
      if (node.hasAttribute("inert")) return false;
      if (node.getAttribute("aria-hidden") === "true") return false;
      if (node.hidden) return false;
      // `offsetParent` is null for display:none (except on <body> / fixed).
      // Use getClientRects as a secondary check.
      node = node.parentElement;
    }
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    return true;
  }

  function getFocusable(): HTMLElement[] {
    const raw = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const out: HTMLElement[] = [];
    for (const el of raw) {
      if (el.hasAttribute("disabled")) continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      if (el.hasAttribute("inert")) continue;
      // `contenteditable="false"` should not be focusable via this path.
      const ce = el.getAttribute("contenteditable");
      if (ce !== null && ce === "false") continue;
      if (!isEffectivelyVisible(el)) continue;
      out.push(el);
    }
    return out;
  }

  const onTrapKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = getFocusable();
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
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
  };
  container.addEventListener("keydown", onTrapKeydown);

  if (options.autoFocus !== false) {
    queueMicrotask(() => {
      const first = getFocusable()[0];
      first?.focus();
    });
  }

  // Restore focus on removal. The observer is scoped to the trap container
  // itself (subtree so nested mutations fire the callback) — the `isConnected`
  // check below handles container-level removal via the disposer path.
  let trapObserver: MutationObserver | null = null;

  function restoreFocusAndCleanup(): void {
    if (options.restoreFocus !== false) previouslyFocused?.focus();
    container.removeEventListener("keydown", onTrapKeydown);
    if (trapObserver) {
      trapObserver.disconnect();
      trapObserver = null;
    }
  }

  if (options.restoreFocus !== false) {
    trapObserver = new MutationObserver(() => {
      if (!container.isConnected) {
        restoreFocusAndCleanup();
      }
    });

    queueMicrotask(() => {
      if (container.isConnected) {
        trapObserver!.observe(container, { childList: true, subtree: true });
      }
    });
  }

  // Integrate with dispose() so SPA navigations and when()/match()/each()
  // clean up the observer even without a DOM removal event.
  registerDisposer(container, restoreFocusAndCleanup);

  return container;
}

/**
 * hotkey registers a keyboard shortcut handler.
 *
 * Returns a `dispose()` cleanup function — call it from the owning
 * component's unmount path to remove the `keydown` listener from
 * `document`. The returned function is idempotent only via the
 * browser's default `removeEventListener` semantics, so callers
 * should invoke it exactly once.
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
 *
 * Rapid successive calls are serialized through an internal per-priority
 * queue so that each message has a chance to be read before the next one
 * overwrites the live region.
 */
const announceQueues: Record<"polite" | "assertive", string[]> = {
  polite: [],
  assertive: [],
};
const announceDraining: Record<"polite" | "assertive", boolean> = {
  polite: false,
  assertive: false,
};
const ANNOUNCE_INTERVAL_MS = 150;

function ensureLiveRegion(priority: "polite" | "assertive"): HTMLElement {
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
  return region;
}

function drainAnnounceQueue(priority: "polite" | "assertive"): void {
  if (announceDraining[priority]) return;
  const queue = announceQueues[priority];
  if (queue.length === 0) return;
  announceDraining[priority] = true;

  const region = ensureLiveRegion(priority);
  const next = queue.shift() as string;

  region.textContent = "";
  requestAnimationFrame(() => {
    if (!region.isConnected) {
      announceDraining[priority] = false;
      return;
    }
    region.textContent = next;
    setTimeout(() => {
      announceDraining[priority] = false;
      drainAnnounceQueue(priority);
    }, ANNOUNCE_INTERVAL_MS);
  });
}

export function announce(message: string, priority: "polite" | "assertive" = "polite"): void {
  if (typeof document === "undefined") return;
  announceQueues[priority].push(message);
  drainAnnounceQueue(priority);
}
