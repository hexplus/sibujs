import { signal } from "../core/signals/signal";

/**
 * pointerLock wraps the Pointer Lock API as a reactive controller.
 * Exposes a `locked` signal plus `request(el)` / `exit()` actions.
 *
 * Pointer lock hides the cursor and delivers unbounded relative-motion
 * mouse events — essential for FPS games, 3D viewers, sketching apps.
 *
 * @example
 * ```ts
 * const pl = pointerLock();
 * canvas.addEventListener("click", () => pl.request(canvas));
 * window.addEventListener("mousemove", (e) => {
 *   if (pl.locked()) turnCamera(e.movementX, e.movementY);
 * });
 * ```
 */
export function pointerLock(): {
  locked: () => boolean;
  /**
   * Request pointer lock on `element`. Resolves once the browser grants it and
   * rejects with the browser's own error (e.g. missing user activation), so the
   * failure can be caught and shown. Resolves without doing anything when the
   * element has no Pointer Lock support (e.g. iOS Safari) or during SSR, so a
   * fire-and-forget `onclick: () => lock.request(el)` never raises an unhandled
   * rejection there; check `locked()` to see whether the lock took effect.
   */
  request: (element: Element) => Promise<void>;
  exit: () => void;
  dispose: () => void;
} {
  const [locked, setLocked] = signal(false);

  if (typeof document === "undefined") {
    return {
      locked,
      request: () => Promise.resolve(),
      exit: () => {},
      dispose: () => {},
    };
  }

  const handler = () => {
    setLocked(!!document.pointerLockElement);
  };
  document.addEventListener("pointerlockchange", handler);

  function request(element: Element): Promise<void> {
    if (typeof element.requestPointerLock !== "function") {
      return Promise.resolve();
    }
    // Modern browsers return a promise that rejects on refusal; discarding it
    // turned permission failures into unhandled rejections nobody could catch.
    // Older implementations return undefined, and some throw synchronously —
    // both are normalized into this one promise.
    try {
      const result = (element.requestPointerLock as () => unknown)();
      return Promise.resolve(result).then(() => undefined);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function exit() {
    if (typeof document.exitPointerLock === "function") {
      document.exitPointerLock();
    }
  }

  function dispose() {
    document.removeEventListener("pointerlockchange", handler);
  }

  return { locked, request, exit, dispose };
}
