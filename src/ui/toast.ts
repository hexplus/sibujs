import { signal } from "../core/signals/signal";

/**
 * Toast notification system with auto-dismiss and max toast limits.
 */

export interface Toast {
  id: string;
  message: string;
  type?: "info" | "success" | "error" | "warning";
}

export interface ToastInstance {
  toasts: () => Toast[];
  show: (message: string, type?: Toast["type"]) => string;
  /** Show an info toast. */
  info: (message: string) => string;
  /** Show a success toast. */
  success: (message: string) => string;
  /** Show an error toast. */
  error: (message: string) => string;
  /** Show a warning toast. */
  warning: (message: string) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

export function toast(options?: { duration?: number; maxToasts?: number }): ToastInstance {
  const duration = options?.duration ?? 3000;
  const maxToasts = options?.maxToasts ?? Infinity;
  const [toasts, setToasts] = signal<Toast[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-instance counter — avoids cross-instance id collisions and leakage
  // of a module-global counter across tests / SSR runs.
  let toastCounter = 0;

  function show(message: string, type?: Toast["type"]): string {
    const id = `toast-${++toastCounter}`;
    const toast: Toast = { id, message, type };

    // Compute which toasts (if any) will be trimmed BEFORE the set call so
    // we can (a) skip scheduling a timer for a toast that will be trimmed
    // immediately and (b) perform timer cleanup OUTSIDE the signal updater
    // (updaters must be pure).
    const trimmedIds: string[] = [];
    setToasts((prev) => {
      const next = [...prev, toast];
      if (next.length > maxToasts) {
        const removed = next.splice(0, next.length - maxToasts);
        for (const r of removed) trimmedIds.push(r.id);
      }
      return next;
    });

    // Apply timer side effects AFTER the set call.
    for (const tid of trimmedIds) clearTimerForToast(tid);

    const wasTrimmed = trimmedIds.indexOf(id) !== -1;
    if (duration > 0 && !wasTrimmed) {
      const timer = setTimeout(() => {
        dismiss(id);
      }, duration);
      timers.set(id, timer);
    }

    return id;
  }

  function dismiss(id: string): void {
    clearTimerForToast(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function dismissAll(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    setToasts([]);
  }

  function clearTimerForToast(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  return {
    toasts,
    show,
    info: (message: string) => show(message, "info"),
    success: (message: string) => show(message, "success"),
    error: (message: string) => show(message, "error"),
    warning: (message: string) => show(message, "warning"),
    dismiss,
    dismissAll,
  };
}
