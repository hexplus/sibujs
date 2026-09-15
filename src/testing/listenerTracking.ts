/**
 * Listener tracking for accessibility checks.
 *
 * Listeners added with `addEventListener` leave no trace in the DOM, so
 * `checkKeyboardAccess` could not see `on: { click }` handlers attached by the
 * framework. Once tracking is enabled, `EventTarget.prototype.addEventListener`
 * and `removeEventListener` are wrapped to record which listeners each element
 * currently has. Because the wrap sits below the framework, it covers tag
 * factories, `html` templates and hand-written listeners alike, in development
 * and production builds, without adding anything to the core bundle.
 *
 * The testing entry point enables tracking when it loads. Listeners attached
 * before that are not seen. State lives on a global symbol, so several copies of
 * the testing utilities share one wrap.
 */

type Tracker = WeakMap<EventTarget, Map<string, Set<unknown>>>;

const KEY = Symbol.for("sibujs.listenerTracking.v1");
const host = globalThis as { [KEY]?: Tracker };

/** Start recording element listeners. Idempotent. */
export function enableListenerTracking(): void {
  if (host[KEY] || typeof EventTarget === "undefined") return;
  const tracker: Tracker = new WeakMap();
  host[KEY] = tracker;

  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;

  proto.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    add.call(this, type, listener as EventListener, options as AddEventListenerOptions);
    if (listener != null && typeof Element !== "undefined" && this instanceof Element) {
      let types = tracker.get(this);
      if (!types) tracker.set(this, (types = new Map()));
      let listeners = types.get(type);
      if (!listeners) types.set(type, (listeners = new Set()));
      listeners.add(listener);
    }
  };

  proto.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    remove.call(this, type, listener as EventListener, options as EventListenerOptions);
    const listeners = tracker.get(this)?.get(type);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) tracker.get(this)?.delete(type);
    }
  };
}

/** Event types `el` currently has listeners for (recorded while tracking is enabled). */
export function listenerTypes(el: Element): ReadonlySet<string> {
  const types = host[KEY]?.get(el);
  return new Set(types ? types.keys() : []);
}
