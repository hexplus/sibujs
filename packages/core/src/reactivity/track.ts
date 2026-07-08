import { devWarn, isDev } from "../core/dev";
import * as core from "./track-core";

// ---------------------------------------------------------------------------
// Reactive core — duplicate-instance-resilient facade.
//
// Under bundler dependency pre-bundling (Vite optimizeDeps / esbuild, and
// similar) this module routinely gets materialized TWICE on one page — once
// with the optimizer's `?v=<hash>` query and once raw. With plain per-copy
// module state, the two copies form two independent reactive "worlds": a
// `signal()` write routed through copy A notifies copy A's queue/subscriber
// lists, while a `track()` binding registered itself via copy B's
// `currentSubscriber`. The dependency edge crosses the instance boundary, the
// notification never lands, and reactivity silently dies.
//
// The fix, WITHOUT touching the hot path: the FIRST copy to load publishes its
// implementations (from ./track-core) on a `globalThis` registry keyed by a
// versioned `Symbol.for`; every later copy re-exports THOSE functions instead
// of its own. So exactly one copy's `track-core` code ever runs — using plain
// module-local `let`/`const` state, byte-identical to a single-instance build,
// with no shared-object indirection and therefore no perf cost — and all copies
// funnel through that single source of truth.
//
// (An earlier attempt that shared the *state* behind property/box access
// measurably regressed binding/effect creation — the hottest paths read and
// write the tracking context per edge. Sharing the *functions* avoids that
// entirely, because the duplicate copies' code simply never runs.)
//
// The `.v1` suffix is the LAYOUT version: bump it only on an incompatible change
// to what these functions expect of each other / of signal & subscriber objects,
// so mixed-version pages that are still layout-compatible keep sharing. Keep it
// in lockstep with batch.ts's sibling registry key.
// ---------------------------------------------------------------------------

const _isDev = isDev();

// Build version stamped onto the registry. Mirrors the `__SIBU_DEV__` define
// pattern: the bundler may inline `__SIBU_VERSION__`; under the test runner /
// raw ESM it is undefined, so we fall back to "dev". Only used to enrich the
// multi-instance dev warning.
declare const __SIBU_VERSION__: string | undefined;
// The `__SIBU_VERSION__` branch only runs when a bundler inlined the define; the
// source test runner always takes the "dev" fallback, so that side is excluded.
/* v8 ignore next */
const _runtimeVersion = typeof __SIBU_VERSION__ !== "undefined" ? __SIBU_VERSION__ : "dev";

interface ReactiveApi {
  suspendTracking: typeof core.suspendTracking;
  resumeTracking: typeof core.resumeTracking;
  isTrackingSuspended: typeof core.isTrackingSuspended;
  untracked: typeof core.untracked;
  retrack: typeof core.retrack;
  track: typeof core.track;
  reactiveBinding: typeof core.reactiveBinding;
  recordDependency: typeof core.recordDependency;
  cleanup: typeof core.cleanup;
  setMaxSubscriberRepeats: typeof core.setMaxSubscriberRepeats;
  setMaxDrainIterations: typeof core.setMaxDrainIterations;
  drainNotificationQueue: typeof core.drainNotificationQueue;
  queueSignalNotification: typeof core.queueSignalNotification;
  notifySubscribers: typeof core.notifySubscribers;
  getSubscriberCount: typeof core.getSubscriberCount;
  getSubscriberDeps: typeof core.getSubscriberDeps;
  forEachSubscriber: typeof core.forEachSubscriber;
  version: string;
  __dupWarned?: boolean;
}

const REGISTRY_KEY = Symbol.for("sibujs.reactive.v1");

function resolveReactiveApi(): ReactiveApi {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ReactiveApi };
  const existing = g[REGISTRY_KEY];
  if (existing) {
    // A prior copy already published its API. By construction a single instance
    // evaluates this module exactly once, so reaching here means a SECOND copy
    // of the reactive runtime was loaded on this page.
    //
    // Since v4 the engine ships as its own package (@sibujs/core), so proper
    // dedup is a PACKAGING guarantee — a single resolved @sibujs/core means this
    // branch never runs. This registry is therefore a dev-only TRIPWIRE: it
    // surfaces a duplicate install (usually a bundler misconfig or a version
    // mismatch pulling two @sibujs/core copies) and, best-effort, delegates to
    // the first copy so reactivity keeps working. Correctness in supported
    // single-install setups does NOT depend on it.
    if (_isDev && !existing.__dupWarned) {
      existing.__dupWarned = true;
      devWarn(
        "Multiple instances of the reactive runtime detected on this page " +
          `(active: ${existing.version}, duplicate: ${_runtimeVersion}). Reactivity ` +
          "still works — all copies share the first one — but de-duplicate " +
          "@sibujs/core in your bundler (e.g. Vite resolve.dedupe: ['@sibujs/core'], " +
          "or ensure a single version resolves across packages).",
      );
    }
    return existing;
  }
  const local: ReactiveApi = {
    suspendTracking: core.suspendTracking,
    resumeTracking: core.resumeTracking,
    isTrackingSuspended: core.isTrackingSuspended,
    untracked: core.untracked,
    retrack: core.retrack,
    track: core.track,
    reactiveBinding: core.reactiveBinding,
    recordDependency: core.recordDependency,
    cleanup: core.cleanup,
    setMaxSubscriberRepeats: core.setMaxSubscriberRepeats,
    setMaxDrainIterations: core.setMaxDrainIterations,
    drainNotificationQueue: core.drainNotificationQueue,
    queueSignalNotification: core.queueSignalNotification,
    notifySubscribers: core.notifySubscribers,
    getSubscriberCount: core.getSubscriberCount,
    getSubscriberDeps: core.getSubscriberDeps,
    forEachSubscriber: core.forEachSubscriber,
    version: _runtimeVersion,
  };
  g[REGISTRY_KEY] = local;
  return local;
}

// Resolved once at module init. In the single-instance case this IS this copy's
// own functions, so the exports below are exactly the local implementations.
const API: ReactiveApi = resolveReactiveApi();

export const suspendTracking: ReactiveApi["suspendTracking"] = API.suspendTracking;
export const resumeTracking: ReactiveApi["resumeTracking"] = API.resumeTracking;
export const isTrackingSuspended: ReactiveApi["isTrackingSuspended"] = API.isTrackingSuspended;
export const untracked: ReactiveApi["untracked"] = API.untracked;
export const retrack: ReactiveApi["retrack"] = API.retrack;
export const track: ReactiveApi["track"] = API.track;
export const reactiveBinding: ReactiveApi["reactiveBinding"] = API.reactiveBinding;
export const recordDependency: ReactiveApi["recordDependency"] = API.recordDependency;
export const cleanup: ReactiveApi["cleanup"] = API.cleanup;
export const setMaxSubscriberRepeats: ReactiveApi["setMaxSubscriberRepeats"] = API.setMaxSubscriberRepeats;
export const setMaxDrainIterations: ReactiveApi["setMaxDrainIterations"] = API.setMaxDrainIterations;
export const drainNotificationQueue: ReactiveApi["drainNotificationQueue"] = API.drainNotificationQueue;
export const queueSignalNotification: ReactiveApi["queueSignalNotification"] = API.queueSignalNotification;
export const notifySubscribers: ReactiveApi["notifySubscribers"] = API.notifySubscribers;
export const getSubscriberCount: ReactiveApi["getSubscriberCount"] = API.getSubscriberCount;
export const getSubscriberDeps: ReactiveApi["getSubscriberDeps"] = API.getSubscriberDeps;
export const forEachSubscriber: ReactiveApi["forEachSubscriber"] = API.forEachSubscriber;
