// ============================================================================
// EXTENDED TESTING QUERIES
// ============================================================================
//
// Companion to `src/testing/index.ts`. Adds the `queryBy*` /
// `findBy*` flavors that Testing Library users expect, plus a
// signal-aware `waitForSignal` helper that resolves when a reactive
// getter satisfies a predicate.

import { effect } from "../core/signals/effect";

// ─── non-throwing queries ────────────────────────────────────────────────

/**
 * Find an element by its exact or substring text content. Returns
 * `null` if no match is found — unlike `getByText`, does not throw.
 */
export function queryByText(container: HTMLElement, text: string): HTMLElement | null {
  const walk = (node: HTMLElement): HTMLElement | null => {
    if (node.childNodes.length === 1 && node.childNodes[0].nodeType === 3) {
      if (node.textContent?.includes(text)) return node;
    }
    for (const child of Array.from(node.children)) {
      const found = walk(child as HTMLElement);
      if (found) return found;
    }
    return null;
  };
  return walk(container);
}

export function queryByTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

export function queryByRole(container: HTMLElement, role: string): HTMLElement | null {
  return container.querySelector(`[role="${role}"]`);
}

/**
 * Escape characters that are special inside a CSS identifier selector.
 * Used as a fallback when `globalThis.CSS.escape` is not available
 * (headless runtimes like jsdom only partially implement the CSS API).
 */
function cssEscape(value: string): string {
  const g = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS && typeof g.CSS.escape === "function") return g.CSS.escape(value);
  return value.replace(/[^\w-]/g, (m) => `\\${m.charCodeAt(0).toString(16)} `);
}

export function queryByLabel(container: HTMLElement, labelText: string): HTMLElement | null {
  // Look for a <label> that contains the text, then follow its `for` attribute
  // or find the nearest labellable child.
  const labels = Array.from(container.querySelectorAll("label"));
  for (const label of labels) {
    if (label.textContent?.trim() === labelText) {
      const forId = label.getAttribute("for");
      if (forId) {
        // Use the scoped selector first so we respect the `container` bound.
        const target = container.querySelector(`#${cssEscape(forId)}`);
        if (target) return target as HTMLElement;
      }
      // Implicit association: first labellable descendant
      const child = label.querySelector("input, select, textarea, button");
      if (child) return child as HTMLElement;
    }
  }
  // Fallback: aria-label
  return container.querySelector(`[aria-label="${labelText}"]`);
}

// ─── async finders ────────────────────────────────────────────────────────

async function pollUntil<T>(fn: () => T | null, timeout: number, interval: number, errorIfTimeout: string): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve, reject) => {
    const check = () => {
      const result = fn();
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= timeout) {
        reject(new Error(errorIfTimeout));
        return;
      }
      setTimeout(check, interval);
    };
    check();
  });
}

export interface FindOptions {
  timeout?: number;
  interval?: number;
}

/**
 * Resolve with the first element whose text matches, polling until
 * `timeout` ms elapse. Useful for async content (data fetching,
 * transitions, etc.) that appears after the initial render.
 */
export function findByText(container: HTMLElement, text: string, options: FindOptions = {}): Promise<HTMLElement> {
  return pollUntil(
    () => queryByText(container, text),
    options.timeout ?? 1000,
    options.interval ?? 50,
    `findByText: no element with text "${text}" after ${options.timeout ?? 1000}ms`,
  );
}

export function findByTestId(container: HTMLElement, testId: string, options: FindOptions = {}): Promise<HTMLElement> {
  return pollUntil(
    () => queryByTestId(container, testId),
    options.timeout ?? 1000,
    options.interval ?? 50,
    `findByTestId: no element with data-testid="${testId}" after ${options.timeout ?? 1000}ms`,
  );
}

export function findByRole(container: HTMLElement, role: string, options: FindOptions = {}): Promise<HTMLElement> {
  return pollUntil(
    () => queryByRole(container, role),
    options.timeout ?? 1000,
    options.interval ?? 50,
    `findByRole: no element with role="${role}" after ${options.timeout ?? 1000}ms`,
  );
}

// ─── signal-aware wait ────────────────────────────────────────────────────

/**
 * Wait until a reactive getter satisfies a predicate. Unlike `waitFor`,
 * this subscribes to the getter so it reacts immediately on signal
 * updates rather than polling. Falls back to a `timeout` rejection.
 *
 * @example
 * ```ts
 * await waitForSignal(() => loading(), (v) => v === false);
 * ```
 */
export function waitForSignal<T>(
  getter: () => T,
  predicate: (value: T) => boolean,
  options: { timeout?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeout ?? 1000;
  return new Promise<T>((resolve, reject) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (resolved) return;
      resolved = true;
      // Always clear the timer — cheap no-op if it already fired, and
      // guarantees we never leak a pending handle on any resolve path.
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    timer = setTimeout(() => {
      finish(() => {
        teardown();
        reject(new Error(`waitForSignal: predicate did not match within ${timeoutMs}ms`));
      });
    }, timeoutMs);

    const teardown = effect(() => {
      if (resolved) return;
      const value = getter();
      if (predicate(value)) {
        finish(() => {
          // Defer teardown so the current effect pass completes cleanly
          queueMicrotask(() => teardown());
          resolve(value);
        });
      }
    });
  });
}

// ─── typing helper ────────────────────────────────────────────────────────

/**
 * Type a full string into an input, dispatching an input event after
 * each character. This is closer to real user input than a single
 * `fireEvent.input(el, value)` call and catches handlers that only
 * run on specific event shapes.
 */
export function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  for (const char of text) {
    element.value += char;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
}
