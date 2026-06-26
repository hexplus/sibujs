import { signal } from "../core/signals/signal";
import { globalSingleton } from "../utils/globalSingleton";

/**
 * dialog provides reactive dialog state management with escape-to-close support.
 *
 * A module-level stack tracks open dialogs across the app so that pressing
 * Escape only closes the top (most recently opened) dialog — nested dialog
 * stacks (e.g. a confirm modal opened on top of a settings sheet) behave
 * intuitively without every owner having to wire its own listener.
 *
 * Call `dispose()` when the owning component unmounts to ensure the dialog
 * is removed from the stack even if it is still open.
 */

type DialogEntry = {
  close: () => void;
};

// Shared via globalSingleton so a duplicated copy of this module doesn't keep
// its own stack + listener — otherwise each copy attaches its own keydown
// handler and "Escape closes the top dialog" breaks across copies.
const _dlg = globalSingleton(Symbol.for("sibujs.dialog.v1"), () => ({
  stack: [] as DialogEntry[],
  listenerAttached: false,
}));
const dialogStack = _dlg.stack;

/**
 * Test-only helper to reset the module-level stack between specs. Client-only:
 * in SSR dialog() is never meaningfully invoked. In production the stack is
 * bounded by open dialog count and cleaned via removeFromStack/dispose.
 *
 * @internal
 */
export function __resetDialogStack(): void {
  while (dialogStack.length > 0) dialogStack.pop();
  if (typeof window !== "undefined" && _dlg.listenerAttached) {
    window.removeEventListener("keydown", handleGlobalKeydown);
    _dlg.listenerAttached = false;
  }
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const top = dialogStack[dialogStack.length - 1];
  if (top) top.close();
}

function ensureGlobalListener(): void {
  if (typeof window === "undefined" || _dlg.listenerAttached) return;
  window.addEventListener("keydown", handleGlobalKeydown);
  _dlg.listenerAttached = true;
}

function removeGlobalListenerIfIdle(): void {
  if (typeof window === "undefined") return;
  if (!_dlg.listenerAttached) return;
  if (dialogStack.length > 0) return;
  window.removeEventListener("keydown", handleGlobalKeydown);
  _dlg.listenerAttached = false;
}

export function dialog(): {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  toggle: () => void;
  dispose: () => void;
} {
  const [isOpen, setIsOpen] = signal(false);
  const entry: DialogEntry = { close: () => close() };

  function pushOnStack(): void {
    // Avoid duplicate pushes if open() is called twice.
    if (dialogStack.indexOf(entry) !== -1) return;
    dialogStack.push(entry);
    ensureGlobalListener();
  }

  function removeFromStack(): void {
    const idx = dialogStack.indexOf(entry);
    if (idx !== -1) dialogStack.splice(idx, 1);
    removeGlobalListenerIfIdle();
  }

  function open(): void {
    if (isOpen()) return;
    setIsOpen(true);
    pushOnStack();
  }

  function close(): void {
    if (!isOpen()) {
      // Still make sure we're off the stack.
      removeFromStack();
      return;
    }
    setIsOpen(false);
    removeFromStack();
  }

  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  function dispose(): void {
    removeFromStack();
    setIsOpen(false);
  }

  return { open, close, isOpen, toggle, dispose };
}
