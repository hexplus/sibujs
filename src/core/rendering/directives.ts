import { track } from "../../reactivity/track";
import { dispose } from "./dispose";
import type { NodeChild } from "./types";

/**
 * Conditional rendering directive. Shows or hides an element reactively.
 * Unlike `when()`, the element is always created — it just toggles display.
 *
 * @param condition Reactive getter returning boolean
 * @param element The element to show/hide
 * @returns The element with reactive display binding
 *
 * @example
 * ```ts
 * const [visible, setVisible] = signal(true);
 * div({ nodes: [show(() => visible(), span({ nodes: "I toggle!" }))] });
 * ```
 */
export function show<T extends Element>(condition: () => boolean, element: T): T {
  const update = () => {
    (element as unknown as HTMLElement).style.display = condition() ? "" : "none";
  };
  track(update);
  return element;
}

/**
 * Conditional rendering directive. Renders content only when condition is true.
 * When false, renders nothing (comment placeholder). Re-evaluates reactively.
 *
 * @param condition Reactive getter returning boolean
 * @param thenBranch Function returning element when true
 * @param elseBranch Optional function returning element when false
 * @returns A Comment anchor that manages the conditional content
 *
 * @example
 * ```ts
 * when(
 *   () => isLoggedIn(),
 *   () => div({ nodes: "Welcome!" }),
 *   () => div({ nodes: "Please log in" })
 * );
 * ```
 */
export function when<T>(condition: () => T, thenBranch: () => NodeChild, elseBranch?: () => NodeChild): Comment {
  const anchor = document.createComment("when");
  let currentNode: Node | null = null;
  let lastCondition: T | undefined;

  let initialized = false;

  const update = () => {
    // Always evaluate condition to register reactive dependencies
    const show = condition();

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip DOM work if condition boolean hasn't changed
    if (initialized && show === lastCondition) return;
    lastCondition = show;

    // Remove previous node
    if (currentNode?.parentNode) {
      dispose(currentNode);
      currentNode.parentNode.removeChild(currentNode);
      currentNode = null;
    }

    const result = show ? thenBranch() : elseBranch ? elseBranch() : null;
    if (result != null) {
      const node = result instanceof Node ? result : document.createTextNode(String(result));
      parent.insertBefore(node, anchor.nextSibling);
      currentNode = node;
    }
    initialized = true;
  };

  track(update);

  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) update();
    });
  }

  return anchor;
}

/**
 * Pattern matching directive. Renders content based on matching a reactive value
 * against multiple cases. Similar to a switch statement.
 *
 * @param value Reactive getter returning the value to match
 * @param cases Object mapping values to render functions
 * @param fallback Optional default case if no match found
 * @returns A Comment anchor that manages the matched content
 *
 * @example
 * ```ts
 * match(
 *   () => status(),
 *   {
 *     loading: () => Spinner(),
 *     error: () => ErrorMessage(),
 *     success: () => Content(),
 *   },
 *   () => div({ nodes: "Unknown status" })
 * );
 * ```
 */
export function match<T extends string | number>(
  value: () => T,
  cases: Record<string, () => NodeChild>,
  fallback?: () => NodeChild,
): Comment {
  const anchor = document.createComment("match");
  let currentNode: Node | null = null;
  let lastKey: string | undefined;

  let initialized = false;

  const update = () => {
    // Always evaluate value() to register reactive dependencies
    const key = String(value());

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip DOM work if matched key hasn't changed
    if (initialized && key === lastKey) return;
    lastKey = key;

    if (currentNode?.parentNode) {
      dispose(currentNode);
      currentNode.parentNode.removeChild(currentNode);
      currentNode = null;
    }

    const renderFn = cases[key] || fallback;
    if (renderFn) {
      const result = renderFn();
      if (result != null) {
        const node = result instanceof Node ? result : document.createTextNode(String(result));
        parent.insertBefore(node, anchor.nextSibling);
        currentNode = node;
      }
    }
    initialized = true;
  };

  track(update);

  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) update();
    });
  }

  return anchor;
}
