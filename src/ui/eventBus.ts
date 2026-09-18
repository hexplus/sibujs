import { reportError } from "../core/errors";

/**
 * eventBus creates a typed publish/subscribe event system.
 * No reactive state needed -- pure event dispatching.
 *
 * `emit()` delivers to the handlers registered when it starts. A throwing
 * handler is reported through the runtime error pipeline and the remaining
 * handlers still run. Handlers added during delivery receive the next event;
 * handlers removed (or cleared) during delivery are skipped for the rest of it.
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
  // One record per subscription. emit() snapshots RECORDS, not handlers, so a
  // handler removed and re-added during delivery is a new record that starts
  // with the next event instead of passing for the old subscription. Adding the
  // same handler again while subscribed keeps the existing subscription.
  interface Subscription {
    handler: (data: any) => void;
    active: boolean;
  }
  const listeners = new Map<keyof T, Map<(data: any) => void, Subscription>>();

  function on<K extends keyof T>(event: K, handler: (data: T[K]) => void): () => void {
    let subs = listeners.get(event);
    if (!subs) {
      subs = new Map();
      listeners.set(event, subs);
    }
    let subscription = subs.get(handler);
    if (!subscription) {
      subscription = { handler, active: true };
      subs.set(handler, subscription);
    }
    const own = subscription;
    // A stale handle (its subscription already removed) must not remove a
    // later subscription of the same handler.
    return () => {
      if (listeners.get(event)?.get(handler) !== own) return;
      off(event, handler);
    };
  }

  function emit<K extends keyof T>(event: K, data: T[K]): void {
    const subs = listeners.get(event);
    if (!subs || subs.size === 0) return;
    // Snapshot: iterating the live map ran handlers added mid-delivery in the
    // same emit, and a handler that kept adding handlers never let it finish.
    for (const subscription of Array.from(subs.values())) {
      // off() and clear() deactivate the record, so removals mid-delivery skip.
      if (!subscription.active) continue;
      try {
        subscription.handler(data);
      } catch (err) {
        reportError(err, { phase: "event", name: `eventBus(${String(event)})` });
      }
    }
  }

  function off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    const subs = listeners.get(event);
    if (!subs) return;
    const subscription = subs.get(handler);
    if (!subscription) return;
    subscription.active = false;
    subs.delete(handler);
    if (subs.size === 0) {
      listeners.delete(event);
    }
  }

  function clear(): void {
    for (const subs of listeners.values()) {
      for (const subscription of subs.values()) subscription.active = false;
    }
    listeners.clear();
  }

  return { on, emit, off, clear };
}
