import { signal } from "../core/signals/signal";

export interface MutationObserverOptions extends MutationObserverInit {}

/**
 * mutationObserver wraps the DOM MutationObserver as a reactive signal of
 * the latest batch of mutations. Typical uses: reacting to externally
 * injected content (third-party embeds), watching attribute flips the app
 * doesn't directly control, or migrating legacy non-reactive code.
 *
 * For anything inside a single component prefer reactive DOM bindings —
 * this is an escape hatch for cross-boundary observation.
 *
 * @param target Element to observe
 * @param options Standard MutationObserverInit (childList, subtree, …)
 *
 * @example
 * ```ts
 * const obs = mutationObserver(document.body, { childList: true, subtree: true });
 * effect(() => {
 *   const records = obs.records();
 *   if (records.length) handleExternalChanges(records);
 * });
 * ```
 */
export function mutationObserver(
  target: Node,
  options: MutationObserverOptions = { childList: true, subtree: true },
): { records: () => MutationRecord[]; dispose: () => void } {
  const [records, setRecords] = signal<MutationRecord[]>([]);

  if (typeof MutationObserver === "undefined") {
    return { records, dispose: () => {} };
  }

  const observer = new MutationObserver((batch) => {
    setRecords(batch);
  });

  observer.observe(target, options);

  function dispose() {
    observer.disconnect();
  }

  return { records, dispose };
}
