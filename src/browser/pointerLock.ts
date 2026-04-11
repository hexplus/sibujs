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
  request: (element: Element) => void;
  exit: () => void;
  dispose: () => void;
} {
  const [locked, setLocked] = signal(false);

  if (typeof document === "undefined") {
    return {
      locked,
      request: () => {},
      exit: () => {},
      dispose: () => {},
    };
  }

  const handler = () => {
    setLocked(!!document.pointerLockElement);
  };
  document.addEventListener("pointerlockchange", handler);

  function request(element: Element) {
    if (typeof element.requestPointerLock === "function") {
      element.requestPointerLock();
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
