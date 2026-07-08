/**
 * eventBus creates a typed publish/subscribe event system.
 * No reactive state needed -- pure event dispatching.
 */
export function eventBus<T extends Record<string, unknown>>(): {
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
