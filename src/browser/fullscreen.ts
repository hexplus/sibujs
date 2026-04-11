import { signal } from "../core/signals/signal";

/**
 * fullscreen wraps the Fullscreen API as a reactive signal plus `enter`/
 * `exit`/`toggle` actions. Tracks `document.fullscreenElement` via the
 * `fullscreenchange` event so the signal stays in sync when the user presses
 * Escape or the browser forces an exit.
 *
 * @returns `{ isFullscreen, element, enter, exit, toggle, dispose }`
 *
 * @example
 * ```ts
 * const fs = fullscreen();
 * button({
 *   nodes: () => (fs.isFullscreen() ? "Exit fullscreen" : "Enter fullscreen"),
 *   on: { click: () => fs.toggle(videoEl) },
 * });
 * ```
 */
export function fullscreen(): {
  isFullscreen: () => boolean;
  element: () => Element | null;
  enter: (el: Element) => Promise<void>;
  exit: () => Promise<void>;
  toggle: (el: Element) => Promise<void>;
  dispose: () => void;
} {
  if (typeof document === "undefined") {
    const [isFullscreen] = signal(false);
    const [element] = signal<Element | null>(null);
    return {
      isFullscreen,
      element,
      enter: async () => {},
      exit: async () => {},
      toggle: async () => {},
      dispose: () => {},
    };
  }

  const [isFullscreen, setIsFullscreen] = signal(!!document.fullscreenElement);
  const [element, setElement] = signal<Element | null>(document.fullscreenElement);

  const handler = () => {
    setIsFullscreen(!!document.fullscreenElement);
    setElement(document.fullscreenElement);
  };

  document.addEventListener("fullscreenchange", handler);

  async function enter(el: Element): Promise<void> {
    if (!document.fullscreenElement && el.requestFullscreen) {
      await el.requestFullscreen();
    }
  }

  async function exit(): Promise<void> {
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    }
  }

  async function toggle(el: Element): Promise<void> {
    if (document.fullscreenElement) await exit();
    else await enter(el);
  }

  function dispose(): void {
    document.removeEventListener("fullscreenchange", handler);
  }

  return { isFullscreen, element, enter, exit, toggle, dispose };
}
