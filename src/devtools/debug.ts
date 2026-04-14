// ============================================================================
// DEBUG MODE & PERFORMANCE MONITORING
// ============================================================================

let debugEnabled = false;
const perfMarks = new Map<string, number[]>();

/**
 * Enable debug mode — enables verbose logging.
 */
export function enableDebug(): void {
  debugEnabled = true;
  console.log("[SibuJS] Debug mode enabled");
}

/**
 * Disable debug mode.
 */
export function disableDebug(): void {
  debugEnabled = false;
}

/**
 * Check if debug mode is active.
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Log a debug message (only when debug mode is enabled).
 */
export function debugLog(component: string, action: string, data?: unknown): void {
  if (!debugEnabled) return;
  console.log(`[SibuJS:${component}] ${action}`, data !== undefined ? data : "");
}

/**
 * perfTracker tracks render timing for a component.
 */
export function perfTracker(label: string): {
  startMeasure: () => void;
  endMeasure: () => number;
  getAverageTime: () => number;
  getRenderCount: () => number;
} {
  if (!perfMarks.has(label)) {
    perfMarks.set(label, []);
  }
  let startTime = 0;

  function startMeasure(): void {
    startTime = globalThis.performance.now();
  }

  function endMeasure(): number {
    const elapsed = globalThis.performance.now() - startTime;
    perfMarks.get(label)?.push(elapsed);
    if (debugEnabled) {
      debugLog("Perf", `${label}: ${elapsed.toFixed(2)}ms`);
    }
    return elapsed;
  }

  function getAverageTime(): number {
    const times = perfMarks.get(label) || [];
    if (times.length === 0) return 0;
    return times.reduce((a, b) => a + b, 0) / times.length;
  }

  function getRenderCount(): number {
    return (perfMarks.get(label) || []).length;
  }

  return { startMeasure, endMeasure, getAverageTime, getRenderCount };
}

/**
 * measureRender wraps a component and measures its render time.
 */
export function measureRender<P>(label: string, component: (props: P) => HTMLElement): (props: P) => HTMLElement {
  const perf = perfTracker(label);

  return (props: P) => {
    perf.startMeasure();
    const el = component(props);
    perf.endMeasure();
    return el;
  };
}

/**
 * Get all collected performance data.
 */
export function getPerformanceReport(): Record<
  string,
  {
    count: number;
    average: number;
    min: number;
    max: number;
    total: number;
  }
> {
  const report: Record<string, { count: number; average: number; min: number; max: number; total: number }> = {};
  for (const [label, times] of perfMarks) {
    if (times.length === 0) continue;
    report[label] = {
      count: times.length,
      average: times.reduce((a, b) => a + b, 0) / times.length,
      min: Math.min(...times),
      max: Math.max(...times),
      total: times.reduce((a, b) => a + b, 0),
    };
  }
  return report;
}

/**
 * Clear all performance data.
 */
export function clearPerformanceData(): void {
  perfMarks.clear();
}

/**
 * Memory leak detector — tracks subscriptions and warns about potential leaks.
 */
const trackedCleanups = new Map<string, Array<() => void>>();

export function trackCleanup(component: string, cleanup: () => void): void {
  if (!trackedCleanups.has(component)) {
    trackedCleanups.set(component, []);
  }
  trackedCleanups.get(component)?.push(cleanup);
}

export function runCleanups(component: string): void {
  const cleanups = trackedCleanups.get(component);
  if (cleanups) {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn("[SibuJS debug] cleanup threw:", err);
        }
      }
    }
    trackedCleanups.delete(component);
  }
}

export function checkLeaks(): Record<string, number> {
  const leaks: Record<string, number> = {};
  for (const [component, cleanups] of trackedCleanups) {
    if (cleanups.length > 0) {
      leaks[component] = cleanups.length;
    }
  }
  if (debugEnabled && Object.keys(leaks).length > 0) {
    console.warn("[SibuJS] Potential memory leaks detected:", leaks);
  }
  return leaks;
}
