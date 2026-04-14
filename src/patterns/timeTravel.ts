import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

// ============================================================================
// TIME-TRAVEL DEBUGGING
// ============================================================================

export interface TimeTravelReturn<T> {
  value: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  history: () => T[];
  index: () => number;
  reset: () => void;
  jumpTo: (index: number) => void;
}

/**
 * timeline wraps a state value with undo/redo history.
 */
export function timeline<T>(initial: T, maxHistory = 100): TimeTravelReturn<T> {
  const [history, setHistory] = signal<T[]>([initial]);
  const [index, setIndex] = signal(0);

  const value = derived(() => history()[index()]);
  const canUndo = derived(() => index() > 0);
  const canRedo = derived(() => index() < history().length - 1);

  function set(next: T | ((prev: T) => T)): void {
    const current = value();
    const newValue = typeof next === "function" ? (next as (prev: T) => T)(current) : next;

    if (Object.is(newValue, current)) return;

    const hist = history();
    const idx = index();

    // Discard any redo history
    const newHistory = hist.slice(0, idx + 1);
    newHistory.push(newValue);

    // Trim if exceeds max. Wrap in batch() so history + index update
    // atomically — otherwise derived(value) can observe a transient state
    // where index points past the array.
    batch(() => {
      if (newHistory.length > maxHistory) {
        newHistory.shift();
        setHistory(newHistory);
        setIndex(newHistory.length - 1);
      } else {
        setHistory(newHistory);
        setIndex(idx + 1);
      }
    });
  }

  function undo(): void {
    if (canUndo()) {
      setIndex(index() - 1);
    }
  }

  function redo(): void {
    if (canRedo()) {
      setIndex(index() + 1);
    }
  }

  function reset(): void {
    batch(() => {
      setHistory([initial]);
      setIndex(0);
    });
  }

  function jumpTo(targetIndex: number): void {
    const hist = history();
    if (targetIndex >= 0 && targetIndex < hist.length) {
      setIndex(targetIndex);
    }
  }

  return { value, set, undo, redo, canUndo, canRedo, history, index, reset, jumpTo };
}
