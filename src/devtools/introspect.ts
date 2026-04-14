/**
 * DevTools introspection utilities for SibuJS.
 *
 * These functions allow dev tools to inspect the reactive dependency graph
 * at runtime. They are designed to be zero-cost when not used — no overhead
 * is added to the hot path. Information is read from tags already placed
 * on signals/getters by signal, derived, etc.
 */

import type { ReactiveSignal } from "../reactivity/signal";

// Internal subscriber type matches track.ts
const SUBS = "__s" as const;

/** Info about a reactive node in the dependency graph */
export interface ReactiveNodeInfo {
  /** Debug name if provided (e.g., signal(0, { name: "count" })) */
  name: string | undefined;
  /** Internal signal reference */
  signal: ReactiveSignal;
  /** Number of subscribers */
  subscriberCount: number;
}

/**
 * Get the debug name of a signal getter function.
 * Returns undefined if no name was provided.
 *
 * @example
 * const [count] = signal(0, { name: "count" });
 * getSignalName(count); // "count"
 */
export function getSignalName(getter: () => unknown): string | undefined {
  return (getter as unknown as Record<string, unknown>).__name as string | undefined;
}

/**
 * Get the number of active subscribers for a signal getter.
 *
 * @example
 * const [count] = signal(0);
 * effect(() => count()); // +1 subscriber
 * getSubscriberCount(count); // 1
 */
export function getSubscriberCount(getter: () => unknown): number {
  const signal = (getter as unknown as Record<string, unknown>).__signal as ReactiveSignal | undefined;
  if (!signal) return 0;
  const subs = (signal as Record<string, unknown>)[SUBS] as Set<unknown> | undefined;
  return subs ? subs.size : 0;
}

/**
 * Get the dependency list of an effect or computed subscriber function.
 * Returns signal references that the subscriber depends on.
 *
 * Note: This reads the _deps Set that track.ts maintains on subscriber functions.
 */
export function getDependencies(subscriberFn: () => void): ReactiveSignal[] {
  const deps = (subscriberFn as unknown as Record<string, unknown>)._deps as Set<ReactiveSignal> | undefined;
  return deps ? Array.from(deps) : [];
}

/**
 * Inspect a signal getter — returns name, signal ref, and subscriber count.
 */
export function inspectSignal(getter: () => unknown): ReactiveNodeInfo | null {
  const signal = (getter as unknown as Record<string, unknown>).__signal as ReactiveSignal | undefined;
  if (!signal) return null;

  const subs = (signal as Record<string, unknown>)[SUBS] as Set<unknown> | undefined;

  return {
    name: (getter as unknown as Record<string, unknown>).__name as string | undefined,
    signal,
    subscriberCount: subs ? subs.size : 0,
  };
}

/**
 * Walk the full reactive graph starting from a signal getter.
 * Returns a tree of signal → subscribers → their signals → etc.
 * Useful for devtools visualization.
 *
 * Set maxDepth to limit traversal (default: 10).
 */
export function walkDependencyGraph(
  getter: () => unknown,
  maxDepth = 10,
  visited: WeakSet<ReactiveSignal> = new WeakSet(),
): { name: string | undefined; subscribers: number; downstream: ReturnType<typeof walkDependencyGraph>[] } {
  const signal = (getter as unknown as Record<string, unknown>).__signal as ReactiveSignal | undefined;
  if (!signal || maxDepth <= 0 || visited.has(signal)) {
    return { name: getSignalName(getter), subscribers: 0, downstream: [] };
  }
  visited.add(signal);

  const subs = (signal as Record<string, unknown>)[SUBS] as Set<() => void> | undefined;
  const downstream: ReturnType<typeof walkDependencyGraph>[] = [];

  if (subs) {
    for (const sub of subs) {
      const subSig = (sub as unknown as Record<string, unknown>)._sig as ReactiveSignal | undefined;
      if (subSig && !visited.has(subSig)) {
        const subName = (subSig as Record<string, unknown>).__name;
        const fakeGetter = (() => undefined) as unknown as () => unknown;
        const tag = fakeGetter as unknown as Record<string, unknown>;
        tag.__signal = subSig;
        if (subName !== undefined) tag.__name = subName;
        downstream.push(walkDependencyGraph(fakeGetter, maxDepth - 1, visited));
      }
    }
  }

  return {
    name: getSignalName(getter),
    subscribers: subs ? subs.size : 0,
    downstream,
  };
}
