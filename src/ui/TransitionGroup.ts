import { reportError } from "../core/errors";
import { signal } from "../core/signals/signal";

/**
 * TransitionGroup manages enter/leave/move animations on a dynamic set of elements.
 * Tracks element positions for FLIP-style move animations.
 */

export interface TransitionGroupOptions {
  enter?: (el: HTMLElement) => void | Promise<void>;
  leave?: (el: HTMLElement) => void | Promise<void>;
  move?: (el: HTMLElement) => void;
}

export function TransitionGroup(options: TransitionGroupOptions): {
  add: (el: HTMLElement) => void;
  remove: (el: HTMLElement) => Promise<void>;
  track: (elements: HTMLElement[]) => void;
} {
  const [elements, setElements] = signal<HTMLElement[]>([]);
  const positions = new Map<HTMLElement, DOMRect>();

  // Runs a user animation callback without letting it break the group: a
  // synchronous throw is reported and iteration continues, and a returned
  // thenable is observed so a rejection is reported (with the element) instead
  // of surfacing as a global unhandled rejection.
  function runCallback(name: string, callback: (el: HTMLElement) => unknown, el: HTMLElement): void {
    const report = (error: unknown) =>
      reportError(error, { phase: "async", name: `TransitionGroup.${name}`, node: el });
    try {
      const result = callback(el);
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).then(undefined, report);
      }
    } catch (error) {
      report(error);
    }
  }

  function add(el: HTMLElement): void {
    setElements((prev) => [...prev, el]);
    if (options.enter) runCallback("enter", options.enter, el);
  }

  async function remove(el: HTMLElement): Promise<void> {
    if (options.leave) {
      await options.leave(el);
    }
    // Drop the cached rect too — otherwise an element removed via remove()
    // (rather than track(), which clears the whole map) lingers in `positions`
    // for the group's lifetime.
    positions.delete(el);
    setElements((prev) => prev.filter((e) => e !== el));
  }

  function track(newElements: HTMLElement[]): void {
    // Record old positions before update
    const oldPositions = new Map<HTMLElement, DOMRect>();
    for (const el of elements()) {
      if (typeof el.getBoundingClientRect === "function") {
        oldPositions.set(el, el.getBoundingClientRect());
      }
    }

    // Handle entering elements (in newElements but not in current)
    const currentSet = new Set(elements());
    for (const el of newElements) {
      if (!currentSet.has(el)) {
        if (options.enter) runCallback("enter", options.enter, el);
      }
    }

    // Handle leaving elements (in current but not in newElements)
    const newSet = new Set(newElements);
    for (const el of elements()) {
      if (!newSet.has(el)) {
        if (options.leave) runCallback("leave", options.leave, el);
      }
    }

    // Update tracked elements
    setElements(newElements);

    // Handle move animations using FLIP technique
    if (options.move) {
      for (const el of newElements) {
        const oldRect = oldPositions.get(el);
        if (oldRect && typeof el.getBoundingClientRect === "function") {
          const newRect = el.getBoundingClientRect();
          if (oldRect.left !== newRect.left || oldRect.top !== newRect.top) {
            runCallback("move", options.move, el);
          }
        }
      }
    }

    // Store new positions
    positions.clear();
    for (const el of newElements) {
      if (typeof el.getBoundingClientRect === "function") {
        positions.set(el, el.getBoundingClientRect());
      }
    }
  }

  return { add, remove, track };
}
