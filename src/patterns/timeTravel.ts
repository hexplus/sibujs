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
  /**
   * Dispose the internal `value`, `canUndo` and `canRedo` deriveds and remove
   * them from DevTools. Afterwards they return their last values. Idempotent.
   */
  dispose: () => void;
}

/**
 * timeline wraps a state value with undo/redo history.
 *
 * @param maxHistory How many entries (including the current one) to keep. Must
 *   be a positive safe integer — `0`, negative, fractional, `NaN` or infinite
 *   capacities throw a `RangeError`, since they would evict the current value
 *   and break the index invariant.
 */
export function timeline<T>(initial: T, maxHistory = 100): TimeTravelReturn<T> {
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) {
    throw new RangeError(`[timeline] maxHistory must be a positive safe integer, got ${maxHistory}`);
  }
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

  function dispose(): void {
    value.dispose();
    canUndo.dispose();
    canRedo.dispose();
  }

  return { value, set, undo, redo, canUndo, canRedo, history, index, reset, jumpTo, dispose };
}
