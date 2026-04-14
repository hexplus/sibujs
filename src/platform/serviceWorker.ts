import { signal } from "../core/signals/signal";

// ============================================================================
// SERVICE WORKER INTEGRATION
// ============================================================================

export interface ServiceWorkerState {
  registration: () => ServiceWorkerRegistration | null;
  isReady: () => boolean;
  isUpdateAvailable: () => boolean;
  error: () => Error | null;
  update: () => Promise<void>;
  unregister: () => Promise<boolean>;
}

/**
 * serviceWorker registers and manages a service worker.
 */
export function serviceWorker(scriptUrl: string, options?: RegistrationOptions): ServiceWorkerState {
  const [registration, setRegistration] = signal<ServiceWorkerRegistration | null>(null);
  const [isReady, setIsReady] = signal(false);
  const [isUpdateAvailable, setIsUpdateAvailable] = signal(false);
  const [error, setError] = signal<Error | null>(null);

  let disposed = false;
  let updateFoundHandler: (() => void) | null = null;
  let stateChangeHandler: (() => void) | null = null;
  let trackedWorker: ServiceWorker | null = null;
  let trackedReg: ServiceWorkerRegistration | null = null;

  function detachListeners() {
    if (trackedReg && updateFoundHandler) {
      trackedReg.removeEventListener("updatefound", updateFoundHandler);
    }
    if (trackedWorker && stateChangeHandler) {
      trackedWorker.removeEventListener("statechange", stateChangeHandler);
    }
    updateFoundHandler = null;
    stateChangeHandler = null;
    trackedWorker = null;
    trackedReg = null;
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(scriptUrl, options)
      .then((reg) => {
        if (disposed) return;
        setRegistration(reg);
        setIsReady(true);
        trackedReg = reg;
        updateFoundHandler = () => {
          if (disposed) return;
          const newWorker = reg.installing;
          if (newWorker) {
            // Detach prior installing-worker listener so multiple updatefound
            // events don't accumulate statechange listeners on stale workers.
            if (trackedWorker && stateChangeHandler) {
              trackedWorker.removeEventListener("statechange", stateChangeHandler);
            }
            trackedWorker = newWorker;
            stateChangeHandler = () => {
              if (disposed) return;
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                setIsUpdateAvailable(true);
              }
            };
            newWorker.addEventListener("statechange", stateChangeHandler);
          }
        };
        reg.addEventListener("updatefound", updateFoundHandler);
      })
      .catch((err) => {
        if (disposed) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async function update(): Promise<void> {
    const reg = registration();
    if (reg) {
      await reg.update();
    }
  }

  async function unregister(): Promise<boolean> {
    disposed = true;
    detachListeners();
    const reg = registration();
    if (reg) {
      const result = await reg.unregister();
      if (result) {
        setRegistration(null);
        setIsReady(false);
      }
      return result;
    }
    return false;
  }

  return { registration, isReady, isUpdateAvailable, error, update, unregister };
}
