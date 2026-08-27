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
 *
 * LIFECYCLE CONTRACT
 * ------------------
 * Registration is asynchronous and `unregister()` can be called at any point
 * during it, so this tracks four distinct situations rather than one boolean:
 *
 *   registering      register() in flight, nothing to unregister yet
 *   active           registration adopted, listeners attached
 *   unregister asked requested before the registration resolved — the arriving
 *                    registration is unregistered rather than adopted, so the
 *                    browser never keeps a worker SibuJS has forgotten
 *   unregistered     terminal, and only entered once unregister() actually
 *                    RETURNED TRUE
 *
 * The last point is the important one. `ServiceWorkerRegistration.unregister()`
 * returns `false` when the browser declined — the worker is still installed and
 * still controlling pages. Treating that as teardown (detaching listeners,
 * dropping the registration) left the wrapper permanently blind to a worker
 * that was very much alive: no update tracking, no registration, no way back.
 * A failed unregister therefore changes nothing.
 */
export function serviceWorker(scriptUrl: string, options?: RegistrationOptions): ServiceWorkerState {
  const [registration, setRegistration] = signal<ServiceWorkerRegistration | null>(null);
  const [isReady, setIsReady] = signal(false);
  const [isUpdateAvailable, setIsUpdateAvailable] = signal(false);
  const [error, setError] = signal<Error | null>(null);

  /** Terminal: unregister() succeeded. */
  let unregistered = false;
  /** unregister() was called; an arriving registration must not be adopted. */
  let unregisterRequested = false;
  let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

  let updateFoundHandler: (() => void) | null = null;
  let stateChangeHandler: (() => void) | null = null;
  let trackedWorker: ServiceWorker | null = null;
  let trackedReg: ServiceWorkerRegistration | null = null;

  // SSR / DOM-less runtimes have no `navigator` at all, so a bare
  // `"serviceWorker" in navigator` threw a TypeError on import-and-call rather
  // than reporting an unsupported environment.
  const supported = typeof navigator !== "undefined" && !!navigator.serviceWorker;

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

  function attachListeners(reg: ServiceWorkerRegistration) {
    trackedReg = reg;
    updateFoundHandler = () => {
      if (unregistered) return;
      const newWorker = reg.installing;
      if (newWorker) {
        // Detach prior installing-worker listener so multiple updatefound
        // events don't accumulate statechange listeners on stale workers.
        if (trackedWorker && stateChangeHandler) {
          trackedWorker.removeEventListener("statechange", stateChangeHandler);
        }
        trackedWorker = newWorker;
        stateChangeHandler = () => {
          if (unregistered) return;
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            setIsUpdateAvailable(true);
          }
        };
        newWorker.addEventListener("statechange", stateChangeHandler);
      }
    };
    reg.addEventListener("updatefound", updateFoundHandler);
  }

  /**
   * Decide what to do with a registration that has just resolved.
   * Returns the registration when it was adopted, `null` when it was
   * unregistered on arrival.
   */
  async function adopt(reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration | null> {
    if (unregisterRequested) {
      const ok = await reg.unregister();
      if (ok) {
        unregistered = true;
        return null;
      }
      // The browser refused. The worker is live, so adopt it normally — losing
      // the reference here is exactly how a registration becomes orphaned.
      unregisterRequested = false;
    }
    setRegistration(reg);
    setIsReady(true);
    attachListeners(reg);
    return reg;
  }

  if (supported) {
    registrationPromise = navigator.serviceWorker
      .register(scriptUrl, options)
      .then(adopt)
      .catch((err) => {
        if (!unregistered) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
        return null;
      });
  }

  async function update(): Promise<void> {
    const reg = registration();
    if (reg) {
      await reg.update();
    }
  }

  async function unregister(): Promise<boolean> {
    if (!supported || unregistered) return false;

    unregisterRequested = true;

    // Wait out an in-flight registration first. Without this the call sees a
    // null registration, reports "nothing to do", and the worker that lands a
    // moment later stays registered in the browser forever.
    if (registrationPromise) {
      await registrationPromise.catch(() => null);
      // `adopt()` may have already unregistered the arriving registration.
      if (unregistered) return true;
    }

    const reg = registration();
    if (!reg) {
      unregisterRequested = false;
      return false;
    }

    const result = await reg.unregister();
    if (result) {
      detachListeners();
      setRegistration(null);
      setIsReady(false);
      setIsUpdateAvailable(false);
      unregistered = true;
    } else {
      // Refused: keep the registration, keep the listeners, stay operational.
      unregisterRequested = false;
    }
    return result;
  }

  return { registration, isReady, isUpdateAvailable, error, update, unregister };
}
