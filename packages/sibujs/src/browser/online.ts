import { signal } from "@sibujs/core";

/**
 * online returns a reactive boolean tracking the browser's online/offline status.
 * Wraps `navigator.onLine` with online/offline event listeners.
 *
 * @returns Object with reactive online getter and dispose function for cleanup
 */
export function online(): { online: () => boolean; dispose: () => void } {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    const [online] = signal(true);
    return { online, dispose: () => {} };
  }

  const [online, setOnline] = signal(navigator.onLine);

  const onOnline = () => setOnline(true);
  const onOffline = () => setOnline(false);

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  function dispose() {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  }

  return { online, dispose };
}
