/**
 * eventBus creates a typed publish/subscribe event system.
 * No reactive state needed -- pure event dispatching.
 */
// `T extends object`, deliberately NOT `Record<string, unknown>`.
//
// An `interface` has no implicit index signature, so an event map written the
// idiomatic way — `interface AppEvents { message: string }` — fails a
// `Record<string, unknown>` constraint even though the runtime handles it
// perfectly. (A `type` alias passes, which makes the failure look arbitrary.)
// The implementation only ever uses `keyof T` and `T[K]`, so nothing here needs
// an index signature. See tests/types/public-api-contract.test.ts. (TYPE-001)
export function eventBus<T extends object>(): {
  on: <K extends keyof T>(event: K, handler: (data: T[K]) => void) => () => void;
  emit: <K extends keyof T>(event: K, data: T[K]) => void;
  off: <K extends keyof T>(event: K, handler: (data: T[K]) => void) => void;
  clear: () => void;
} {
  const listeners = new Map<keyof T, Set<(data: any) => void>>();

  function on<K extends keyof T>(event: K, handler: (data: T[K]) => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    // Return unsubscribe function
    return () => off(event, handler);
  }

  function emit<K extends keyof T>(event: K, data: T[K]): void {
    const set = listeners.get(event);
    if (set) {
      for (const handler of set) {
        handler(data);
      }
    }
  }

  function off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    const set = listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        listeners.delete(event);
      }
    }
  }

  function clear(): void {
    listeners.clear();
  }

  return { on, emit, off, clear };
}
