import { signal } from "@sibujs/core";

export interface ProfilerResult {
  renderCount: () => number;
  lastRenderTime: () => number;
  averageRenderTime: () => number;
  totalRenderTime: () => number;
  reset: () => void;
}

// Symbol key for internal record method
const RECORD = Symbol("profiler.record");

interface ProfilerInternal extends ProfilerResult {
  [RECORD]: (elapsed: number) => void;
}

/**
 * Creates a component profiler that tracks render counts and timings.
 * Uses performance.now() for high-resolution timing.
 * All outputs are reactive via signal.
 */
export function createProfiler(_name: string): ProfilerResult {
  const [renderCount, setRenderCount] = signal<number>(0);
  const [lastRenderTime, setLastRenderTime] = signal<number>(0);
  const [totalRenderTime, setTotalRenderTime] = signal<number>(0);

  const averageRenderTime = (): number => {
    const count = renderCount();
    if (count === 0) return 0;
    return totalRenderTime() / count;
  };

  const reset = (): void => {
    setRenderCount(0);
    setLastRenderTime(0);
    setTotalRenderTime(0);
  };

  const profiler: ProfilerInternal = {
    renderCount,
    lastRenderTime,
    averageRenderTime,
    totalRenderTime,
    reset,
    [RECORD]: (elapsed: number) => {
      setRenderCount((prev) => prev + 1);
      setLastRenderTime(elapsed);
      setTotalRenderTime((prev) => prev + elapsed);
    },
  };

  return profiler;
}

/**
 * Starts a render measurement for the given profiler.
 * Returns a stop function that records the elapsed time.
 */
export function startMeasure(profiler: ProfilerResult): () => void {
  const start = performance.now();

  return () => {
    const elapsed = performance.now() - start;
    const internal = profiler as ProfilerInternal;
    if (internal[RECORD]) {
      internal[RECORD](elapsed);
    }
  };
}
