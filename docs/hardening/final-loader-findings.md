# Component-Loader Findings — load vs instantiate

Third, narrowly-scoped pass. Baseline in
[final-loader-baseline.md](./final-loader-baseline.md). Supersedes the OUT-004
entry in [final-router-followup-findings.md](./final-router-followup-findings.md).

| ID | Title | Severity | Status |
|---|---|---|---|
| LOAD-001 | Speculative validation invokes user component factories twice | **P1** | Fixed |
| LOAD-002 | Direct `AsyncComponent` Element disposed before mount, then cached and reused | **P1** | Fixed |
| OUT-004 (revised) | Root cause is the validation-probe architecture, not a missing `dispose()` | **P1** | Superseded by the above |

---

## OUT-004 — revised

The previous pass recorded OUT-004 as *"validation probe node leaked; fixed by
disposing it"*. That was the symptom, not the defect. The accurate statement:

> `ComponentLoader` performed **speculative user component instantiation** for
> validation. This caused leaked probe nodes, duplicate user side effects, and
> unsafe disposal/reuse of direct `AsyncComponent` Elements.

The fix is not "dispose the probe" but **remove speculative instantiation**:
validate the actual instance, at mount time.

The previous pass's `dispose(probeNode)` change fixed the leak on the
synchronous and lazy-module paths, where the probe node genuinely is discarded.
On the **direct `AsyncComponent`** path it made things worse: there the probe
node *is* the Element that would later be mounted, so disposing it produced a
dead Element that was then cached and mounted. That regression is LOAD-002
below, and it was introduced by the previous pass rather than found in it.

---

## LOAD-001 — Speculative validation invokes user component factories twice

**Severity:** P1. **Status:** Fixed.

**Reproducers.** `tests/router-hardening-loader-instantiation.test.ts`.

| Case | Expected | Before fix |
|---|---|---|
| sync component, first mount | 1 invocation | **2** |
| sync component, non-DOM side effect | `["created"]` | **`["created", "created"]`** |
| lazy module, first mount | 1 invocation | **2** |
| `preloadRoute` of a lazy route | 0 instantiations | **1** |
| `preloadRoute` of a sync route | 0 instantiations | **1** |

The side-effect case is the one that matters most: `dispose()` cannot undo a
push to an array, an analytics call, or a store write. No amount of probe
cleanup could have made speculative invocation harmless.

**Root cause.** `doLoadComponent()` called the component to check it returned an
`Element`, discarded that node, and returned the component for the caller to
invoke again. `awaitComponent()` did the same after resolving a module. Both ran
at cache-fill time, so `preloadRoute()` — whose entire purpose is to warm the
cache *without* rendering — instantiated a component and built DOM.

**Fix.** Loading and instantiation are now separate operations.

```ts
type RoutePlan =
  | { kind: "factory"; component: Component }
  | { kind: "deferred"; load: AsyncComponent | LazyComponent };
```

- `loadPlan()` resolves a plan and **never invokes a component factory**. A
  syntactically-sync component becomes a `factory` plan with no call at all; a
  syntactically-async one becomes `deferred`, unclassified.
- `instantiate()` creates exactly one instance and validates *that* instance.
  When a `deferred` load resolves to a module, the plan is upgraded to a
  `factory` so the import happens once and later mounts call the factory
  directly.
- `preloadPlan()` resolves modules and caches factories without instantiating.

`RoutePlan` is internal; no public API was added.

**Regression tests.** 16 tests covering sync / lazy / preload / route-table
registration, each asserting a real mount happened so the assertions cannot pass
vacuously.

---

## LOAD-002 — Direct `AsyncComponent` Element disposed before mount, then reused

**Severity:** P1 — mounted dead DOM. **Status:** Fixed.

**Reproducers.** For `component: async () => el`:

| Assertion | Expected | Before fix |
|---|---|---|
| disposer count before mount | 0 | **1** |
| reactive binding live after mount | updates | **dead** |
| disposer count on leaving the route | 1 | **already 1 on entry** |
| revisit creates a fresh instance | 2 invocations | **1** — the disposed Element was reused |

**Root cause.** Three pieces composing:

```text
AsyncComponent resolves Element E
      ↓  extractComponent(E)
() => E                     ← one instance disguised as a reusable factory
      ↓  component()
E
      ↓  dispose(E)          ← the previous pass's probe cleanup
      ↓  componentCache stores () => E, forever
Route mounts E              ← an already-disposed Element
```

`extractComponent()` collapsing an `Element` into `() => result` is the core
conflation: an instance produced by one invocation is not a factory. Every later
navigation to that route re-mounted the same dead node.

**Fix.**

- `extractFactory()` replaces `extractComponent()` and only accepts a callable
  (a bare function or a module `default`). It never wraps an Element.
- A resolved `Element` is recognised in `instantiate()` as *the instance for
  this invocation* and returned directly — never disposed, never cached.
- `RoutePlan` cannot hold an `Element` by construction.
- Concurrent mounts share the in-flight **module** load, but a caller that
  piggy-backed on a load that turned out to be a direct `AsyncComponent` makes
  its own invocation, so an Element is never shared between two mounts.

**Public API.** `AsyncComponent = () => Promise<Element>` remains a first-class
supported route component; it was not narrowed to dodge the bug. RC-003
compatibility for plain (non-`async`-declared) promise-returning functions is
preserved, now via runtime thenable detection on the **real** invocation rather
than on a discarded probe — so classification never costs a duplicate call.

**Regression tests.** 7 tests covering pre-mount liveness, post-mount
reactivity, disposal-on-leave, fresh-instance-on-revisit, thenable
compatibility, and stale-resolution disposal.

---

## Test-infrastructure cleanup (§46)

Removing the probes made three pieces of test infrastructure obsolete. All
encoded the old behaviour and were removed rather than left in place:

| Location | Workaround removed |
|---|---|
| `tests/router-hardening-ownership.test.ts` | `tracked()` skipped disposals of un-mounted nodes; restored to the simple `log.push(name)` |
| `tests/router-hardening-keepalive.test.ts` | `instrumented()` and `SelfDestruct` skipped their first invocation as "the loader's validation call" |
| `examples/keepalive-browser.html` | `instanced()` left the first instance unstamped for the same reason |

The KeepAlive assertions are now strictly stronger: every factory invocation is
counted, because every invocation is a real instantiation. All previously
certified expectations pass unchanged.

Nine `ComponentLoader` tests in `tests/router.coverage.test.ts` were ported from
`loadComponent()` to `loadPlan()` + `instantiateComponent()`. Each keeps its
original intent; two gained an extra assertion that a direct `AsyncComponent`
yields a distinct Element per instantiation.

---

## Behaviour changes worth knowing

- **Component factories now run once per instance**, not twice on first load.
  Applications that had (knowingly or not) come to rely on the double call will
  see one fewer invocation.
- **`preloadRoute()` no longer renders.** It resolves the module and caches the
  factory. For a direct `AsyncComponent` there is nothing to preload without
  instantiating, so the produced Element is disposed and the route stays
  unresolved.
- **Load errors are recorded at instantiation time**, since that is where a
  deferred load now runs. The `errorRetryDelay` rate-limit and the retry button
  behave as before; the bookkeeping moved with the work.

All of this ships inside the unreleased `4.0.0-rc.1`.

---

## Test counts - before / after

| Suite | Baseline | After | Delta |
|---|---|---|---|
| Full unit/integration | 4570 passed, 1 skipped (370 files) | **4586 passed, 1 skipped (371 files)** | **+16** |
| Router suite | 492 passed (31 files) | **508 passed (32 files)** | **+16** |
| ComponentLoader suite | 19 passed (3 files) | **35 passed (4 files)** | **+16** |
| Route/Outlet/KeepAlive | 27 passed (4 files) | **36 passed (5 files)** | **+9** |
| Browser matrix | 192 runs (6 files) | **192 runs (6 files)** | 0 |
| Soak | 21 passed, 1 skipped (2 files) | **21 passed, 1 skipped (2 files)** | 0 |

| Typecheck | Baseline | After |
|---|---|---|
| Source TypeScript errors | 0 | **0** |
| Test TypeScript errors | 0 | **0** |

The router/loader deltas coincide because every new test in this pass lives in
`tests/router-hardening-loader-instantiation.test.ts`.

## Certification

| Gate | Baseline | After |
|---|---|---|
| Build | PASS | PASS |
| TypeScript (src) | PASS | PASS |
| Lint | PASS | PASS |
| Full unit/integration suite | PASS - 4570 | PASS - **4586** |
| TypeScript (tests + entry files) | PASS - 0 errors | PASS - 0 errors |
| Query model fuzzing | PASS | PASS |
| Router model fuzzing | PASS | PASS |
| SSR security fuzzing | PASS | PASS |
| Browser matrix | PASS - 192 runs | PASS - 192 runs |
| Lifecycle + SSR soak | PASS - 21 | PASS - 21 |
| Packed package + subpath exports | PASS - 112/112, 16 subpaths | PASS - 112/112, 16 subpaths |
| Bundler matrix | PASS - 12/12 | PASS - 12/12 |
| Node support matrix | NOT TESTED | NOT TESTED |
| **Result** | ALL REQUIRED GATES PASSED (12/0) | **ALL REQUIRED GATES PASSED (12/0)** |

Package exports and the public runtime API are unchanged - the 112/112 subpath
check is identical before and after, and `RoutePlan` is internal.

### Node floor

Exact Node **22.3.0** is not installed on this host, so the matrix reports
`no interpreter available` for it: **NOT TESTED on this run**, neither PASS nor
FAIL. Node v22.14.0 and v24.19.0 passed every sub-gate. The previously certified
exact-floor evidence is not reinterpreted here.

## Final loader report

```text
COMPONENT LOADER

Sync component first-load invocations:       1
Lazy component first-mount invocations:      1
Preload component instantiations:            0
Speculative validation invocation:           REMOVED

ASYNC COMPONENT

Promise<Element> supported:                  PASS
Disposed before mount:                       NO
Reactive after mount:                        PASS
Disposed once on leave:                      PASS
Disposed stale resolution:                   PASS
Disposed instance reused:                    NO
```

## Ownership regression report

```text
Route ownership:      PASS
Outlet ownership:     PASS
KeepAlive ownership:  PASS
Suspense ownership:   PASS
```

The OUT-001/OUT-002/OUT-003 ownership checks are intact and, on the Route and
Outlet paths, now strictly stronger: the pre-instantiation ownership check gates
`instantiateComponent()`, so a stale generation no longer runs user component
code at all - and with the loader's probe gone, that is now the *only* path on
which a route component can be invoked.
