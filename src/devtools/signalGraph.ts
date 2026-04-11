import { isDev } from "../core/dev";

// ============================================================================
// SIGNAL GRAPH SNAPSHOT + REACTIVE PROFILER
// ============================================================================
//
// The existing `devtools.ts` hooks in a handful of `hook.emit` events
// already (`effect:create`, `effect:destroy`, etc.). This module sits on
// top and exposes two new capabilities:
//
//   1. `captureSignalGraph()` — takes a synchronous snapshot of every
//      signal node currently known to the dev hook, together with its
//      subscribers. The snapshot is a plain serializable object so the
//      devtools panel (or a vitest assertion) can diff it over time.
//
//   2. `createProfiler()` — starts a recording session that writes
//      every effect start/end into an in-memory flamegraph compatible
//      with the Chrome tracing JSON format. Call `stop()` to get a
//      JSON blob you can drop into `chrome://tracing` or the Perfetto
//      UI. Zero cost in production — the whole module short-circuits
//      to no-ops when `isDev()` returns false.
//
// No DOM, no dependencies, pure data. The devtools overlay can pick
// these up via the same `__SIBU_DEVTOOLS_GLOBAL_HOOK__` bus that the
// rest of the dev surface uses.

// ─── Global hook access ───────────────────────────────────────────────────

interface DevHook {
  emit: (event: string, payload: unknown) => void;
  on: (event: string, handler: (payload: unknown) => void) => () => void;
  off: (event: string, handler: (payload: unknown) => void) => void;
  getSignalNodes?: () => Iterable<SignalNodeSnapshot>;
}

interface GlobalWithHook {
  __SIBU_DEVTOOLS_GLOBAL_HOOK__?: DevHook;
}

function getHook(): DevHook | null {
  if (!isDev()) return null;
  const g = globalThis as unknown as GlobalWithHook;
  return g.__SIBU_DEVTOOLS_GLOBAL_HOOK__ ?? null;
}

// ─── Signal graph snapshot ────────────────────────────────────────────────

export interface SignalNodeSnapshot {
  /** Stable id for the node (assigned on first observation). */
  id: string;
  /** Debug name, if the caller tagged the signal. */
  name: string | null;
  /** Runtime type tag: `"signal"`, `"derived"`, `"effect"`. */
  kind: string;
  /** Best-effort preview of the current value. */
  value: string;
  /** Ids of nodes that depend on this one. */
  subscribers: string[];
  /** Ids of nodes this one reads from. */
  dependencies: string[];
  /** Number of times the node has been re-evaluated since creation. */
  evalCount: number;
}

export interface SignalGraphSnapshot {
  capturedAt: number;
  nodes: SignalNodeSnapshot[];
  /** Total edge count for quick health checks. */
  edgeCount: number;
}

/**
 * Capture a synchronous snapshot of the reactive graph. The hook
 * provides a `getSignalNodes()` iterator that the core reactivity
 * layer populates; this function walks it and produces a serializable
 * view with dependency counts.
 *
 * Returns an empty snapshot when devtools are not enabled.
 */
export function captureSignalGraph(): SignalGraphSnapshot {
  const hook = getHook();
  if (!hook || typeof hook.getSignalNodes !== "function") {
    return { capturedAt: Date.now(), nodes: [], edgeCount: 0 };
  }

  const nodes: SignalNodeSnapshot[] = [];
  let edgeCount = 0;
  for (const n of hook.getSignalNodes()) {
    nodes.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      value: n.value,
      subscribers: [...n.subscribers],
      dependencies: [...n.dependencies],
      evalCount: n.evalCount,
    });
    edgeCount += n.dependencies.length;
  }

  return { capturedAt: Date.now(), nodes, edgeCount };
}

/**
 * Diff two snapshots and return a high-level summary: how many new
 * nodes, how many removed, and which nodes re-evaluated between
 * captures. Useful for regression tests that want to assert
 * "navigating to /page X creates exactly N new signals".
 */
export function diffSignalGraphs(
  before: SignalGraphSnapshot,
  after: SignalGraphSnapshot,
): {
  added: SignalNodeSnapshot[];
  removed: SignalNodeSnapshot[];
  reevaluated: SignalNodeSnapshot[];
} {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));

  const added: SignalNodeSnapshot[] = [];
  const removed: SignalNodeSnapshot[] = [];
  const reevaluated: SignalNodeSnapshot[] = [];

  for (const [id, node] of afterById) {
    if (!beforeById.has(id)) {
      added.push(node);
      continue;
    }
    const prev = beforeById.get(id);
    if (prev && prev.evalCount !== node.evalCount) reevaluated.push(node);
  }
  for (const [id, node] of beforeById) {
    if (!afterById.has(id)) removed.push(node);
  }
  return { added, removed, reevaluated };
}

// ─── Reactive profiler ────────────────────────────────────────────────────

export interface ProfilerEvent {
  /** Chrome tracing `name` field — effect/signal label. */
  name: string;
  /** Trace category. */
  cat: string;
  /** `"B"` = begin, `"E"` = end, `"I"` = instant. */
  ph: "B" | "E" | "I";
  /** Timestamp in microseconds since the profiler started. */
  ts: number;
  /** Fixed thread ID — sibujs has one reactive thread. */
  tid: 0;
  /** Fixed process ID. */
  pid: 0;
  /** Arbitrary metadata. */
  args?: Record<string, unknown>;
}

export interface TraceProfilerHandle {
  /** Stop the profiler and return the collected events. */
  stop: () => ProfilerEvent[];
  /** Stop and return a Chrome tracing JSON blob ready for download. */
  stopTrace: () => string;
  /** Whether the profiler is currently recording. */
  isRecording: () => boolean;
}

/**
 * Start recording reactive effect timings. Returns a handle whose
 * `stop()` method yields a list of Chrome tracing events — drop the
 * JSON into `chrome://tracing` or `ui.perfetto.dev` to see the
 * flamegraph.
 *
 * In production this is a no-op; the handle still returns an empty
 * list so callers do not have to branch on `isDev()` themselves.
 *
 * Named `createTraceProfiler` to avoid colliding with the per-component
 * render profiler in `componentProfiler.ts`, which tracks render counts
 * rather than producing a trace file.
 */
export function createTraceProfiler(): TraceProfilerHandle {
  const events: ProfilerEvent[] = [];
  const hook = getHook();
  if (!hook) {
    return {
      stop: () => events,
      stopTrace: () => JSON.stringify({ traceEvents: events }),
      isRecording: () => false,
    };
  }

  const start = typeof performance !== "undefined" ? performance.now() : Date.now();
  let recording = true;

  const onEffectStart = (payload: unknown) => {
    if (!recording) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    const label = (payload as { name?: string }).name ?? "effect";
    events.push({
      name: label,
      cat: "effect",
      ph: "B",
      ts: Math.floor(now * 1000),
      tid: 0,
      pid: 0,
    });
  };
  const onEffectEnd = (payload: unknown) => {
    if (!recording) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    const label = (payload as { name?: string }).name ?? "effect";
    events.push({
      name: label,
      cat: "effect",
      ph: "E",
      ts: Math.floor(now * 1000),
      tid: 0,
      pid: 0,
    });
  };
  const onSignalSet = (payload: unknown) => {
    if (!recording) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    const label = (payload as { name?: string }).name ?? "signal";
    events.push({
      name: label,
      cat: "signal",
      ph: "I",
      ts: Math.floor(now * 1000),
      tid: 0,
      pid: 0,
      args: (payload as { args?: Record<string, unknown> }).args,
    });
  };

  const offStart = hook.on("effect:start", onEffectStart);
  const offEnd = hook.on("effect:end", onEffectEnd);
  const offSet = hook.on("signal:set", onSignalSet);

  function stop(): ProfilerEvent[] {
    if (!recording) return events;
    recording = false;
    offStart();
    offEnd();
    offSet();
    return events;
  }

  function stopTrace(): string {
    stop();
    return JSON.stringify({ traceEvents: events, displayTimeUnit: "ms" });
  }

  return { stop, stopTrace, isRecording: () => recording };
}
