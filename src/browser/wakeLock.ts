import { signal } from "../core/signals/signal";

interface WakeLockSentinel extends EventTarget {
  released: boolean;
  type: "screen";
  release(): Promise<void>;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

/**
 * wakeLock wraps the Screen Wake Lock API to keep the screen awake while the
 * app is doing something the user is watching (video, timer, recipe, nav).
 *
 * Returns a reactive `active` boolean plus `request` / `release` actions.
 * The lock is automatically re-requested if the page becomes visible again
 * after being hidden (browsers auto-release wake locks on tab hide).
 *
 * Gracefully degrades on browsers without the API.
 *
 * @example
 * ```ts
 * const lock = wakeLock();
 * await lock.request();
 * // ... later
 * await lock.release();
 * ```
 */
export function wakeLock(): {
  active: () => boolean;
  request: () => Promise<void>;
  release: () => Promise<void>;
  dispose: () => void;
} {
  const [active, setActive] = signal(false);

  if (typeof navigator === "undefined" || !("wakeLock" in navigator) || typeof document === "undefined") {
    return {
      active,
      request: async () => {},
      release: async () => {},
      dispose: () => {},
    };
  }

  const api = (navigator as unknown as { wakeLock: WakeLockApi }).wakeLock;
  let sentinel: WakeLockSentinel | null = null;

  async function request(): Promise<void> {
    try {
      sentinel = await api.request("screen");
      setActive(true);
      sentinel.addEventListener("release", () => {
        setActive(false);
      });
    } catch {
      setActive(false);
    }
  }

  async function release(): Promise<void> {
    if (sentinel && !sentinel.released) {
      await sentinel.release();
    }
    sentinel = null;
    setActive(false);
  }

  // Re-acquire on visibility return (browsers auto-release when hidden)
  const onVisibility = () => {
    if (sentinel?.released && !document.hidden) {
      request().catch((err) => {
        if (typeof console !== "undefined") {
          console.warn("[SibuJS wakeLock] re-acquire failed:", err);
        }
      });
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  function dispose(): void {
    document.removeEventListener("visibilitychange", onVisibility);
    release().catch((err) => {
      if (typeof console !== "undefined") {
        console.warn("[SibuJS wakeLock] release failed:", err);
      }
    });
  }

  return { active, request, release, dispose };
}
