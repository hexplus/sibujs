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

/**
 * First descendant of `container` whose `attribute` is exactly `value`.
 *
 * Deliberately not `querySelector(`[attr="${value}"]`)`: interpolating an
 * arbitrary attribute value into a selector breaks on quotes, backslashes and
 * brackets (an invalid-selector DOMException) or matches something else. Only
 * the attribute NAME, which is always a fixed literal here, reaches the selector.
 */
export function queryByAttribute(container: ParentNode, attribute: string, value: string): HTMLElement | null {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`))) {
    if (el.getAttribute(attribute) === value) return el;
  }
  return null;
}

/** Every descendant of `container` whose `attribute` is exactly `value`. See {@link queryByAttribute}. */
export function queryAllByAttribute(container: ParentNode, attribute: string, value: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${attribute}]`)).filter(
    (el) => el.getAttribute(attribute) === value,
  );
}

export function queryByTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return queryByAttribute(container, "data-testid", testId);
}

export function queryByRole(container: HTMLElement, role: string): HTMLElement | null {
  return queryByAttribute(container, "role", role);
}

export function queryByLabel(container: HTMLElement, labelText: string): HTMLElement | null {
  // Look for a <label> that contains the text, then follow its `for` attribute
  // or find the nearest labellable child.
  const labels = Array.from(container.querySelectorAll("label"));
  for (const label of labels) {
    if (label.textContent?.trim() === labelText) {
      const forId = label.getAttribute("for");
      if (forId) {
        // Scoped to `container`, and matched exactly rather than via `#id`.
        const target = queryByAttribute(container, "id", forId);
        if (target) return target;
      }
      // Implicit association: first labellable descendant
      const child = label.querySelector("input, select, textarea, button");
      if (child) return child as HTMLElement;
    }
  }
  // Fallback: aria-label
  return queryByAttribute(container, "aria-label", labelText);
}

// ─── async finders ────────────────────────────────────────────────────────

async function pollUntil<T>(fn: () => T | null, timeout: number, interval: number, errorIfTimeout: string): Promise<T> {
  const start = Date.now();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      let result: T | null;
      // A query that throws on a timer poll used to escape from the timer while
      // the returned promise never settled. It now rejects the promise.
      try {
        result = fn();
      } catch (err) {
        reject(err);
        return;
      }
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= timeout) {
        reject(new Error(errorIfTimeout));
        return;
      }
      timer = setTimeout(check, interval);
    };
    check();
    // Every settle path above returns before scheduling, so no timer is left
    // pending once the promise settles.
    void timer;
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
