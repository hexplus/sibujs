// ============================================================================
// TESTING UTILITIES
// ============================================================================

import { dispose } from "../core/rendering/dispose";

/**
 * Escape a value for safe embedding in a CSS attribute selector.
 * Uses the native `CSS.escape` when available (jsdom/browsers) and
 * falls back to a conservative hex-escape otherwise.
 */
function escapeSelector(value: string): string {
  const g = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS && typeof g.CSS.escape === "function") return g.CSS.escape(value);
  return value.replace(/[^\w-]/g, (m) => `\\${m.charCodeAt(0).toString(16)} `);
}

// Tracks containers produced by `render()` so tests can bulk-clean via
// `unmountAll()` when individual `unmount()` calls were missed.
const _renderedContainers = new Set<HTMLElement>();

/**
 * Unmount every container still alive from prior `render()` calls.
 * Safe to call from an `afterEach` hook to guarantee teardown.
 */
export function unmountAll(): void {
  for (const container of _renderedContainers) {
    // Run reactive disposers before clearing markup so effects/listeners
    // registered during render don't leak across tests.
    for (const child of Array.from(container.childNodes)) dispose(child);
    container.replaceChildren();
    if (container.parentNode) container.parentNode.removeChild(container);
  }
  _renderedContainers.clear();
}

/**
 * render mounts a component into a test container and returns helpers.
 *
 * The caller is responsible for calling `unmount()` (typically from an
 * `afterEach` hook). For bulk teardown across many renders, call
 * `unmountAll()` instead — every live container is tracked internally.
 */
export function render(component: () => HTMLElement): {
  container: HTMLElement;
  element: HTMLElement;
  getByText: (text: string) => HTMLElement | null;
  getByTestId: (testId: string) => HTMLElement | null;
  getByRole: (role: string) => HTMLElement | null;
  queryAll: (selector: string) => HTMLElement[];
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  _renderedContainers.add(container);

  const element = component();
  container.appendChild(element);

  function getByText(text: string): HTMLElement | null {
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

  function getByTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${escapeSelector(testId)}"]`);
  }

  function getByRole(role: string): HTMLElement | null {
    return container.querySelector(`[role="${role}"]`);
  }

  function queryAll(selector: string): HTMLElement[] {
    return Array.from(container.querySelectorAll(selector));
  }

  function unmount(): void {
    for (const child of Array.from(container.childNodes)) dispose(child);
    container.replaceChildren();
    if (container.parentNode) container.parentNode.removeChild(container);
    _renderedContainers.delete(container);
  }

  return { container, element, getByText, getByTestId, getByRole, queryAll, unmount };
}

/**
 * fireEvent dispatches a DOM event on an element.
 */
export function fireEvent(element: HTMLElement, eventName: string, eventInit?: EventInit): boolean {
  const event = new Event(eventName, { bubbles: true, cancelable: true, ...eventInit });
  return element.dispatchEvent(event);
}

fireEvent.click = (element: HTMLElement): boolean =>
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

fireEvent.input = (element: HTMLElement, value?: string): boolean => {
  if (value !== undefined && element instanceof HTMLInputElement) {
    element.value = value;
  }
  return element.dispatchEvent(new Event("input", { bubbles: true }));
};

fireEvent.change = (element: HTMLElement, value?: string): boolean => {
  if (value !== undefined && element instanceof HTMLInputElement) {
    element.value = value;
  }
  return element.dispatchEvent(new Event("change", { bubbles: true }));
};

fireEvent.submit = (element: HTMLElement): boolean =>
  element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

fireEvent.keyDown = (element: HTMLElement, key: string, init?: KeyboardEventInit): boolean =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));

fireEvent.keyUp = (element: HTMLElement, key: string, init?: KeyboardEventInit): boolean =>
  element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, ...init }));

fireEvent.focus = (element: HTMLElement): void => element.focus();
fireEvent.blur = (element: HTMLElement): void => element.blur();

/**
 * waitFor retries an assertion until it passes or times out.
 */
export async function waitFor(
  callback: () => void,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 1000, interval = 50 } = options;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        callback();
        resolve();
      } catch (error) {
        if (Date.now() - start >= timeout) {
          reject(error);
        } else {
          setTimeout(check, interval);
        }
      }
    };
    check();
  });
}

/**
 * mockRouter creates a mock router for testing route-dependent components.
 */
export function mockRouter(initialPath = "/"): {
  currentPath: () => string;
  navigate: (path: string) => void;
  history: string[];
} {
  const history: string[] = [initialPath];
  let pathIndex = 0;

  function currentPath(): string {
    return history[pathIndex];
  }

  function navigate(path: string): void {
    history.push(path);
    pathIndex = history.length - 1;
  }

  return { currentPath, navigate, history };
}

/**
 * Creates a mock store for testing.
 */
export function mockStore<T extends Record<string, unknown>>(
  initialState: T,
): {
  getState: () => T;
  setState: (patch: Partial<T>) => void;
  reset: () => void;
} {
  let state = { ...initialState };

  return {
    getState: () => ({ ...state }),
    setState: (patch) => {
      state = { ...state, ...patch };
    },
    reset: () => {
      state = { ...initialState };
    },
  };
}

// Accessibility testing
export * from "./a11y";
// Testing framework adapters
export * from "./adapters";
// E2E testing utilities
export * from "./e2e";
// Extended queries: queryBy*, findBy*, waitForSignal, type()
export * from "./queries";
// Snapshot testing
export * from "./snapshot";
// Visual regression testing
export * from "./visualRegression";
