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
  /**
   * A registration that resolved while an unregister request was outstanding.
   * It is deliberately NOT published — the outstanding request owns it — so a
   * worker that is about to be removed never transiently reports as ready.
   */
  let arrivedRegistration: ServiceWorkerRegistration | null = null;
  /**
   * The single outstanding logical unregister request.
   *
   * `unregister()` is one operation, and it must consume at most one native
   * `registration.unregister()`. Modelling it as an owned in-flight promise —
   * rather than a set of booleans consulted from two places — is what makes
   * that true by construction: every caller joins the same request, and the
   * native call has exactly one site.
   */
  let pendingUnregister: Promise<boolean> | null = null;

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

  /** Publish a registration as the wrapper's active one. */
  function activate(reg: ServiceWorkerRegistration): void {
    setRegistration(reg);
    setIsReady(true);
    attachListeners(reg);
  }

  /**
   * Decide what to do with a registration that has just resolved.
   *
   * This function does NOT call the native unregister, even when a request is
   * outstanding. That was the source of the double attempt: both `adopt()` and
   * the resumed `unregister()` called it, and when the browser refused the
   * first, the second fired against the very registration `adopt()` had just
   * re-adopted. The outstanding request owns the removal; `adopt()` only hands
   * the registration over.
   */
  function adopt(reg: ServiceWorkerRegistration): ServiceWorkerRegistration | null {
    if (unregisterRequested) {
      arrivedRegistration = reg;
      return null;
    }
    activate(reg);
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

  /** The one place `registration.unregister()` is ever called. */
  async function performUnregister(): Promise<boolean> {
    unregisterRequested = true;

    // Wait out an in-flight registration first. Without this the call sees a
    // null registration, reports "nothing to do", and the worker that lands a
    // moment later stays registered in the browser forever.
    if (registrationPromise) await registrationPromise.catch(() => null);

    const reg = registration() ?? arrivedRegistration;
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
      arrivedRegistration = null;
      unregistered = true;
    } else {
      // Refused: the worker is still installed and still controlling pages, so
      // the wrapper stays operational. A registration that arrived while this
      // request was outstanding was withheld from publication — activate it now
      // rather than leaving the browser holding a worker SibuJS forgot about.
      unregisterRequested = false;
      if (!registration() && arrivedRegistration) {
        activate(arrivedRegistration);
        arrivedRegistration = null;
      }
    }
    return result;
  }

  async function unregister(): Promise<boolean> {
    if (!supported || unregistered) return false;

    // Join the outstanding request rather than starting a second one. Two
    // concurrent callers are one logical removal.
    if (pendingUnregister) return pendingUnregister;

    const request = performUnregister();
    pendingUnregister = request;
    // Release the slot once settled so a LATER, genuinely new request (for
    // instance after the browser refused this one) can run. Guarded by identity
    // so a successor is never cleared by its predecessor's cleanup.
    void request
      .catch(() => {})
      .then(() => {
        if (pendingUnregister === request) pendingUnregister = null;
      });

    return request;
  }

  return { registration, isReady, isUpdateAvailable, error, update, unregister };
}
