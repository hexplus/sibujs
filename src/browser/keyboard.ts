import { signal } from "../core/signals/signal";

export interface KeyboardOptions {
  /** Target element. Defaults to `window`. */
  target?: HTMLElement;
  /** Filter: only track these keys (matches `KeyboardEvent.key`). */
  keys?: string[];
}

/**
 * keyboard tracks the set of keys currently held down as a reactive signal.
 * Useful for combo detection, editor-like keybindings, games, and modifier
 * gating ("Shift+click").
 *
 * The returned `pressed` is a reactive `Set<string>` (keyed by
 * `KeyboardEvent.key`). On every key event the signal is replaced with a
 * new Set instance so reactive subscribers see the change.
 *
 * Also listens to `window.blur` to clear stuck keys if the window loses
 * focus mid-press — otherwise held modifiers can "ghost" forever.
 *
 * @example
 * ```ts
 * const kb = keyboard();
 * const isShift = derived(() => kb.pressed().has("Shift"));
 * ```
 */
export function keyboard(options: KeyboardOptions = {}): {
  pressed: () => Set<string>;
  isPressed: (key: string) => boolean;
  dispose: () => void;
} {
  const [pressed, setPressed] = signal<Set<string>>(new Set());

  if (typeof window === "undefined") {
    return {
      pressed,
      isPressed: () => false,
      dispose: () => {},
    };
  }

  const target: HTMLElement | Window = options.target ?? window;
  const filter = options.keys ? new Set(options.keys) : null;

  const onDown = (e: KeyboardEvent) => {
    if (filter && !filter.has(e.key)) return;
    setPressed((prev) => {
      if (prev.has(e.key)) return prev;
      const next = new Set(prev);
      next.add(e.key);
      return next;
    });
  };

  const onUp = (e: KeyboardEvent) => {
    if (filter && !filter.has(e.key)) return;
    setPressed((prev) => {
      if (!prev.has(e.key)) return prev;
      const next = new Set(prev);
      next.delete(e.key);
      return next;
    });
  };

  const onBlur = () => setPressed(new Set());

  target.addEventListener("keydown", onDown as EventListener);
  target.addEventListener("keyup", onUp as EventListener);
  window.addEventListener("blur", onBlur);

  function isPressed(key: string): boolean {
    return pressed().has(key);
  }

  function dispose() {
    target.removeEventListener("keydown", onDown as EventListener);
    target.removeEventListener("keyup", onUp as EventListener);
    window.removeEventListener("blur", onBlur);
  }

  return { pressed, isPressed, dispose };
}
