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
 * The record follows DOM listener identity: an entry is `(type, callback,
 * capture)`, so registering the same callback twice with the same capture flag
 * is one listener, and removing it with the other flag removes nothing. Entries
 * also disappear when a `once` listener is dispatched or its `signal` aborts.
 *
 * The testing entry point enables tracking when it loads. Listeners attached
 * before that are not seen. State lives on a global symbol, so several copies of
 * the testing utilities share one wrap.
 */

interface Entry {
  listener: unknown;
  capture: boolean;
  /** Detaches the internal `once` / abort watchers for this entry. */
  release?: () => void;
}

type Tracker = WeakMap<EventTarget, Map<string, Entry[]>>;

const KEY = Symbol.for("sibujs.listenerTracking.v2");
const host = globalThis as { [KEY]?: Tracker };

function captureOf(options: unknown): boolean {
  if (typeof options === "boolean") return options;
  return typeof options === "object" && options !== null && !!(options as EventListenerOptions).capture;
}

/** Start recording element listeners. Idempotent. */
export function enableListenerTracking(): void {
  if (host[KEY] || typeof EventTarget === "undefined") return;
  const tracker: Tracker = new WeakMap();
  host[KEY] = tracker;

  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;

  const find = (target: EventTarget, type: string, listener: unknown, capture: boolean) =>
    tracker
      .get(target)
      ?.get(type)
      ?.find((e) => e.listener === listener && e.capture === capture);

  const drop = (target: EventTarget, type: string, entry: Entry) => {
    const types = tracker.get(target);
    const entries = types?.get(type);
    if (!types || !entries) return;
    const index = entries.indexOf(entry);
    if (index === -1) return;
    entries.splice(index, 1);
    if (entries.length === 0) types.delete(type);
    entry.release?.();
  };

  proto.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    const tracked = listener != null && typeof Element !== "undefined" && this instanceof Element;
    const capture = captureOf(options);
    const opts = typeof options === "object" && options !== null ? (options as AddEventListenerOptions) : undefined;

    // Not tracked: non-elements, null callbacks, an already-aborted signal (the
    // DOM ignores the call), and duplicates of an existing (type, callback,
    // capture) entry (the DOM keeps the original registration).
    if (!tracked || opts?.signal?.aborted || find(this, type, listener, capture)) {
      add.call(this, type, listener as EventListener, options as AddEventListenerOptions);
      return;
    }

    const entry: Entry = { listener, capture };
    const releases: Array<() => void> = [];

    if (opts?.once) {
      // Registered before the caller's listener, so it runs first in the same
      // dispatch — matching the DOM, which removes a `once` listener before
      // invoking it.
      const onFire = () => drop(this, type, entry);
      add.call(this, type, onFire, { capture, once: true });
      releases.push(() => remove.call(this, type, onFire, { capture }));
    }
    if (opts?.signal) {
      const signal = opts.signal;
      const onAbort = () => drop(this, type, entry);
      add.call(signal, "abort", onAbort, { once: true });
      releases.push(() => remove.call(signal, "abort", onAbort));
    }
    if (releases.length > 0) {
      entry.release = () => {
        for (const release of releases) release();
      };
    }

    let types = tracker.get(this);
    if (!types) tracker.set(this, (types = new Map()));
    let entries = types.get(type);
    if (!entries) types.set(type, (entries = []));
    entries.push(entry);

    add.call(this, type, listener as EventListener, options as AddEventListenerOptions);
  };

  proto.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    remove.call(this, type, listener as EventListener, options as EventListenerOptions);
    const entry = find(this, type, listener, captureOf(options));
    if (entry) drop(this, type, entry);
  };
}

/** Event types `el` currently has listeners for (recorded while tracking is enabled). */
export function listenerTypes(el: Element): ReadonlySet<string> {
  const types = host[KEY]?.get(el);
  return new Set(types ? types.keys() : []);
}
