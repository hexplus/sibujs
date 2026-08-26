# Component-Loader Findings — load vs instantiate

Third, narrowly-scoped pass. Baseline in
[final-loader-baseline.md](./final-loader-baseline.md). Supersedes the OUT-004
entry in [final-router-followup-findings.md](./final-router-followup-findings.md).

| ID | Title | Severity | Status |
|---|---|---|---|
| LOAD-001 | Speculative validation invokes user component factories twice | **P1** | Fixed |
| LOAD-002 | Direct `AsyncComponent` Element disposed before mount, then cached and reused | **P1** | Fixed |
| OUT-004 (revised) | Root cause is the validation-probe architecture, not a missing `dispose()` | **P1** | Superseded by the above |
| LOAD-003 | `preloadRoute()` invoked directly supplied `AsyncComponent` factories | **P2** | Fixed |
| LOAD-004 | Preload permission inferred from `Function#toString()` source text | **P2** | Fixed |

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

## How this arrived at its final shape

Three corrections, in order. Only the last row describes current behaviour.

| Step | State after it |
|---|---|
| **LOAD-001 / LOAD-002** — separate loading from instantiation | The loader stopped invoking components to validate them. Preload resolved modules, but still invoked a direct `AsyncComponent` and disposed the Element. |
| **LOAD-003** — preload no-ops for directly supplied factories | Preload stopped invoking direct factories. Which functions counted as "module loaders" was still decided by looking for `import(` in the function's source. |
| **LOAD-004** — explicit brand is the only authority | **Current.** Only a `lazy()`-branded loader is ever executed during preload. Nothing is inferred from source text, syntax, or a trial invocation. |

## Behaviour changes worth knowing

- **Component factories run once per instance**, not twice on first load.
  Applications that had (knowingly or not) come to rely on the double call see
  one fewer invocation.
- **`preloadRoute()` does not render, and does not invoke component factories.**
  It executes only an explicitly branded `lazy()` loader, importing the module
  and caching its factory uninvoked.
- **Only `lazy()` routes are preloadable.** A route written as
  `() => import("./Page")` still navigates correctly but is no longer preloaded.
  Wrap it in `lazy()` to restore that.
- **Load errors are recorded at instantiation time**, since that is where a
  deferred load now runs. The `errorRetryDelay` rate-limit and the retry button
  behave as before; the bookkeeping moved with the work.

All of this ships inside the unreleased `4.0.0-rc.1`.

---

## LOAD-003 — `preloadRoute()` invoked directly supplied `AsyncComponent` factories

**Severity:** P2. **Status:** Fixed. **Subsystem:** ComponentLoader / preload.

Found in review of the previous pass's own output: the load-vs-instantiate
separation was applied to the loader but not carried through to `preloadRoute()`.

**Reproducers.** `tests/router-hardening-loader-instantiation.test.ts`,
`preload purity` block.

| Route definition | Factory calls during preload — expected | Before fix |
|---|---|---|
| `() => element` | 0 | 0 |
| `() => Promise.resolve(element)` | 0 | 0 |
| `lazy(async () => ({ default: Page }))` | 0 (module import: 1) | 0 |
| `async () => element` | 0 | **1** |
| the same, preloaded 3× | 0 | **3** |
| side effect `effects.push("created")` | `[]` | **`["created"]`** |

**Root cause.** Preload semantics were defined as *"do as much loading as
possible"* rather than the stronger invariant *"never cross the
component-instantiation boundary."*

Concretely, `doLoadPlan()` classified a route as a `deferred` module loader
using `isAsyncComponent()`, which treats **any** `AsyncFunction` as deferred.
That cannot distinguish `async () => import("./Page")` from
`async () => document.createElement("div")`. `preloadPlan()` then resolved every
deferred plan — invoking the second kind, getting an Element, and disposing it.

That is the same "call it and throw the result away" shape this pass had just
removed from validation, and it fails for the same reason: `dispose()` cannot
undo an analytics call, a network request, a store write, or a log line.

**Fix at the time — architectural, not a special case.**

> ⚠️ **Intermediate state — superseded by LOAD-004.** The classifier described
> in this subsection still consulted function source text. It was replaced in
> the very next finding. Read LOAD-004 for the current behaviour.

`isAsyncComponent()` was replaced by `isDeferredModule()`, which recognised only
what appeared to have separable code to fetch:

- the `LAZY_MARKER` stamped by `lazy()`, or
- a dynamic `import(` in the function source. ← *removed by LOAD-004*

`constructor.name === "AsyncFunction"` stopped being a signal. Every directly
supplied factory — synchronous, `async`, or plain promise-returning — became a
`factory` plan, and `preloadPlan()` returned immediately for those: preload
no-ops **by construction**, with no branch that could call them. That part
stands; only the source-text half of the classifier was later removed.

Two supporting changes fell out of the reclassification:

- `instantiateFactory()` now unwraps a factory whose real invocation resolves to
  a module namespace or a bare factory function, so an un-marked
  `async () => ({ default: Page })` still works. The plan is upgraded so later
  mounts skip the extra hop, and the unwrap is depth-bounded.
- Module resolution moved into a shared `resolveModuleFactory()` used by both
  instantiation and preload, so a preload racing a navigation to the same route
  imports once. Without it the two paths each ran the loader arrow.

**Regression tests.** 14 tests: per-form purity, the mandatory
side-effect assertion, a lifecycle-counter sweep across all four definition
styles, repeat-preload idempotency, preload/navigation race, preload of an
unrelated route, module-load failure, and error-surfacing-at-navigation for both
sync and async invalid components.

**Remaining risk.** Low. One behaviour change worth stating, in the stable
semantic form LOAD-004 settled on: **only explicitly deferred/lazy routes are
preloadable.** Unmarked factories are treated as component factories and are
invoked only during actual navigation. Such a route still works correctly; it
simply gets no preload benefit. Wrapping the loader in `lazy()` restores that,
which is what `lazy()` is for.

No public contract depends on whether a function's source literally contains
`import(`.

---

## Documentation audit (§23–§26)

Two suspected documentation duplications were checked and **NOT CONFIRMED**:

| Suspected | Actual |
|---|---|
| duplicate `Route()` rows in `async-ownership.md` | one row per table; both already carry the final `navSeq` + `routeTorn` wording |
| duplicate `unsafe-target` rows in `router.md` | one row, pointing at the target-policy section |

No obsolete rows were left behind by the earlier passes, so nothing was removed.

Terminology was verified consistent across implementation and docs:
`internal` / `external` / `unsafe`, with protocol-relative `//host` classified
**unsafe** everywhere — the comment that once said otherwise was corrected as
DOC-004 in the previous pass.

Current architecture and public docs describe final behaviour only. The phrase
"components are invoked twice on first load" no longer appears anywhere; the
remaining mentions of the old behaviour live in this findings document and are
written as history.

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

---

## LOAD-004 — Preload permission inferred from source text

**Severity:** P2. **Status:** Fixed. **Subsystem:** ComponentLoader / preload classification.

**Reproducers.** `tests/router-hardening-loader-instantiation.test.ts`,
`source text grants no preload authority`.

| Component factory | Preload invocations — expected | Before fix |
|---|---|---|
| contains `const example = "import('./Page')"` | 0 | **1** |
| contains a template literal `` `import("./foo")` `` and a block comment | 0 (×10 preloads) | **10** |
| contains only a `//` line comment mentioning `import(` | 0 | 0 — *see below* |

The line-comment variant passed **before** the fix, which is itself part of the
evidence: TypeScript strips `//` comments before the function ever reaches
runtime, so whether that reproducer fires depends on the build pipeline. A
contract that changes with the transpiler is not a contract.

**Root cause.** The loader replaced runtime-type guessing with **source-text
guessing**:

```ts
comp.toString().includes("import(")
```

Source representation is not semantic metadata and cannot safely grant
permission to execute application code. It fails in both directions:

- **false positive** — an ordinary component mentioning `import(` in a string,
  template literal, or surviving comment becomes executable during preload,
  breaking preload purity. This is the dangerous direction, and it reproduced.
- **false negative** — a bundler that rewrites `import("./Page")` into its own
  chunk-loader call erases the marker, silently losing the preload
  optimisation. Not dangerous, but it shows the heuristic is not stable across
  the toolchains the package certifies against.

No better regex fixes this. The defect is source inspection itself.

**Fix.** `isDeferredModule()` now consults exactly one thing — the `LAZY_MARKER`
brand stamped by `lazy()`:

```ts
private isDeferredModule(comp): boolean {
  return (comp as { [LAZY_MARKER]?: boolean })[LAZY_MARKER] === true;
}
```

A brand is metadata: it survives TypeScript, every bundler, and minification,
because it is part of runtime behaviour rather than syntax. Preload purity
becomes structurally enforceable rather than heuristically defended — an
unbranded factory has no branch that could execute it.

No public API was added. `lazy()` already existed and is now documented as the
explicit opt-in for preloadable code splitting.

**Regression tests.** 3 false-positive tests, 2 unmarked-module-like-factory
tests (preload no-op + navigation still correct, and stale-generation ownership),
plus the existing purity matrix and the preload/navigation race — all green.

**Behaviour change.** `() => import("./Page")` without `lazy()` is no longer
preloaded. It navigates correctly; it simply gets no preload benefit. This
sacrifices an optimisation, not correctness, and `4.0.0-rc.1` is unreleased.

**Residual, disclosed.** Two `Function#toString()` reads remain in `Route()`:
one extracts an import path for a dev error node's `data-component-source`
attribute, the other guesses whether to show a loading spinner. Both are
cosmetic/diagnostic and grant **no** execution permission; the spinner site now
carries a comment saying so. They were left alone as out of scope.

A second residual worth naming: the ownership check runs immediately before and
after `instantiateComponent()`, but an unmarked loader that awaits *inside* it
can still run its second-stage factory for a generation that has since been
superseded. That is wasted work, not a correctness failure — the result is
lifecycle-disposed and never committed, which the test asserts. Closing it would
require threading an ownership callback into the loader, which is beyond this
pass.

---

## Final matrix (LOAD-003)

```text
PRELOAD

Sync factory invoked during preload:               NO
AsyncComponent invoked during preload:             NO
Promise-returning factory invoked during preload:  NO
Lazy module imported during preload:               YES
Lazy component instantiated during preload:        NO
Repeated preload component calls:                  0

NAVIGATION

Sync first mount invocations:                       1
Lazy first mount invocations:                       1
AsyncComponent first mount invocations:             1
Promise-returning first mount invocations:          1

LIFECYCLE

Preload creates disposer-owned nodes:               NO
Async resolved Element alive after mount:           YES
Disposed on leave exactly once:                     PASS
Stale actual resolution disposed:                   PASS
Disposed instance reused:                           NO
```

## Documentation report

```text
Preload docs:                        UPDATED
AsyncComponent preload wording:      UPDATED
Changelog:                           UPDATED
Async ownership duplicate rows:      NOT CONFIRMED (none present)
unsafe-target duplicate row:         NOT CONFIRMED (none present)
Historical findings remain accurate: YES
```

## Test counts - before / after

| Suite | Before | After | Delta |
|---|---|---|---|
| Full unit/integration | 4586 passed, 1 skipped (371 files) | **4597 passed, 1 skipped (371 files)** | **+11** |
| Router suite | 508 passed (32 files) | **519 passed (32 files)** | **+11** |
| ComponentLoader / preload | 35 passed (4 files) | **46 passed (4 files)** | **+11** |
| Route/Outlet/KeepAlive/Suspense | 47 passed (5 files) | **47 passed (5 files)** | 0 |
| Browser matrix | 192 runs | **192 runs** | 0 |
| Soak | 21 passed, 1 skipped | **21 passed, 1 skipped** | 0 |

| Typecheck | Before | After |
|---|---|---|
| Source TypeScript errors | 0 | **0** |
| Test TypeScript errors | 0 | **0** |

The preload block replaced two earlier preload tests with fourteen, so the net
is +11 rather than +14.

## Certification

| Gate | Result |
|---|---|
| Build | PASS |
| TypeScript (src) | PASS |
| Lint | PASS |
| Full unit/integration suite | PASS - 4597 tests, 371 files |
| TypeScript (tests + entry files) | PASS - 0 errors |
| Query / Router / SSR fuzzing | PASS - 6 / 7 / 8 |
| Browser matrix (Chromium/Firefox/WebKit) | PASS - 192 runs |
| Lifecycle + SSR soak | PASS - 21 tests |
| Packed package + subpath exports | PASS - 112/112, 16 subpaths |
| Bundler matrix | PASS - 12/12 |
| Node support matrix | NOT TESTED - 22.3.0 unavailable on this host; 22 PASS, 24 PASS |
| **Result** | **ALL REQUIRED GATES PASSED** (12 PASS / 0 FAIL) |

No public API changed: `preloadRoute()` keeps its signature and its
`Promise<void>` result, and the 112/112 subpath check is unchanged.

### Node floor

Exact Node **22.3.0** is not installed on this host: **NOT TESTED on this run**,
neither PASS nor FAIL. Node v22.14.0 and v24.19.0 passed every sub-gate. The
previously certified exact-floor evidence stands separately and is not
reinterpreted.

## Ownership guards - unchanged and green

```text
Route:      navSeq + routeTorn      PASS
Outlet:     navSeq + outletTorn     PASS
KeepAlive:  updateSeq + kaTorn      PASS
Suspense:   generation + tornDown   PASS
```

The preload correction integrates with these guards rather than replacing them.
Stale-resolution disposal on the real navigation path is unaffected: a component
invoked by an actual route generation whose Promise resolves after supersession
still has its Element disposed exactly once and never mounted.

## Test-scaffolding audit (§39-40)

Searched the router test suites for compensating logic left over from the
removed architectures - `probe`, `validation`, first-call adjustments,
ignore-unmounted filters. The three such helpers found in the previous pass were
already removed then (`tracked()`, `instrumented()`/`SelfDestruct`, and the
browser fixture's `instanced()`). No new scaffolding was introduced by this pass:
every route component invocation in the suite now represents a genuine instance,
and no assertion was weakened to accommodate the change.

---

## Final report (LOAD-004)

```text
PRELOAD CLASSIFICATION

Uses Function#toString():                  NO
Uses source regex/heuristics:              NO
Uses AsyncFunction constructor:            NO
Uses speculative invocation:               NO
Explicit lazy/deferred marker required:    YES

FALSE POSITIVE TESTS

"import(" in string invokes component:     NO
"import(" in comment invokes component:    NO
"import(" in template literal / block:     NO

DIRECT FACTORIES

sync preload invocation:                   0
AsyncComponent preload invocation:         0
Promise-returning preload invocation:      0
unmarked import-loader preload invocation: 0

EXPLICIT LAZY

module imported during preload:            YES
component instantiated during preload:     NO
navigation instantiation count:            1
```

## Documentation report

```text
CHANGELOG stale AsyncComponent preload text: REMOVED (in the LOAD-003 pass; re-verified absent)
router.md stale AsyncComponent exception:    REMOVED (in the LOAD-003 pass; re-verified absent)
source-text preload contract:                REMOVED
lazy() explicit preload contract:            DOCUMENTED
historical findings chronology:              CLEAN
```

Two items the brief expected to still be present were already gone: the
CHANGELOG sentence about a direct `AsyncComponent` having "nothing to preload
without instantiating", and the matching `router.md` paragraph. Both were
removed when LOAD-003 was fixed. Re-checked by search; nothing to do. What *did*
remain was the preload table row describing `() => import("./Page")` as
"recognised by the dynamic `import(` in its source", which is now corrected.

## Test counts - before / after

| Suite | Before | After | Delta |
|---|---|---|---|
| Full unit/integration | 4597 passed, 1 skipped (371 files) | **4602 passed, 1 skipped (371 files)** | **+5** |
| Router suite | 519 passed (32 files) | **524 passed (32 files)** | **+5** |
| ComponentLoader / preload | 46 passed (4 files) | **51 passed (4 files)** | **+5** |
| Ownership suites (Route/Outlet/KeepAlive/Suspense) | 43 passed (4 files) | **43 passed (4 files)** | 0 |
| Browser matrix | 192 runs | **192 runs** | 0 |
| Soak | 21 passed, 1 skipped | **21 passed, 1 skipped** | 0 |

| Typecheck | Before | After |
|---|---|---|
| Source TypeScript errors | 0 | **0** |
| Test TypeScript errors | 0 | **0** |

## Certification

| Gate | Result |
|---|---|
| Build | PASS |
| TypeScript (src) | PASS |
| Lint | PASS |
| Full unit/integration suite | PASS - 4602 tests, 371 files |
| TypeScript (tests + entry files) | PASS - 0 errors |
| Query / Router / SSR fuzzing | PASS - 6 / 7 / 8 |
| Browser matrix (Chromium/Firefox/WebKit) | PASS - 192 runs |
| Lifecycle + SSR soak | PASS - 21 tests |
| Packed package + subpath exports | PASS - 112/112, 16 subpaths |
| Bundler matrix (Vite/Rollup/esbuild/Webpack) | PASS - builds 12/12, runtime 12/12 |
| Node support matrix | NOT TESTED - 22.3.0 unavailable on this host; 22 PASS, 24 PASS |
| **Result** | **ALL REQUIRED GATES PASSED** (12 PASS / 0 FAIL) |

The bundler matrix is the gate that matters most for this change: a brand is
runtime state, so it survives TypeScript, Vite, Rollup, esbuild, Webpack and
minification, where the source-text heuristic it replaced did not. 12/12 builds
and 12/12 runtime checks pass, and `lazy()` usage is unchanged.

No public API changed - `preloadRoute()` keeps its signature and `Promise<void>`
result, `lazy()` is unchanged, and the 112/112 subpath check is identical.

### Node floor

Exact Node **22.3.0** is not installed on this host: **NOT TESTED on this run**,
neither PASS nor FAIL. Node v22.14.0 and v24.19.0 passed every sub-gate. The
previously certified exact-floor evidence stands separately and is not
reinterpreted.

## Ownership guards - unchanged and green

```text
Route:      navSeq + routeTorn      PASS
Outlet:     navSeq + outletTorn     PASS
KeepAlive:  updateSeq + kaTorn      PASS
Suspense:   generation + tornDown   PASS
```

Preload/navigation module-load dedupe is preserved: switching the classifier
from source text to the `lazy()` brand did not touch `resolveModuleFactory()`,
and the race test still shows one import and one instantiation.

---

## Documentation-consistency pass (post-LOAD-004)

A documentation-only sweep after the LOAD-004 runtime fix. **No runtime
behaviour changed** — the full suite reported an identical 4602 passed /
1 skipped / 371 files before and after.

### What was stale

| Location | Stale claim | Action |
|---|---|---|
| `preloadPlan()` JSDoc | "a `deferred` plan whose load turns out to be a direct `AsyncComponent` … that instance is disposed and the plan stays deferred" | Rewritten: factory plan → no-op; deferred plan → resolve module, cache factory, no invocation |
| `RoutePlan` type doc | "a `deferred` load has not yet been classified as lazy-module vs direct `AsyncComponent`" | Rewritten: the two kinds are structural — `deferred` means an explicitly branded `lazy()` loader |
| `doLoadPlan()` JSDoc | "a syntactically-async component is *provisionally* `deferred` … the ambiguity is settled during real instantiation" | Rewritten: the brand decides; nothing is provisional |
| `final-loader-findings.md`, LOAD-003 "Fix" | described the intermediate classifier (`LAZY_MARKER` **or** source `import(`) in a section reading as current | Banner added: *Intermediate state — superseded by LOAD-004*, with the removed half marked inline |
| `final-loader-findings.md`, LOAD-003 "Remaining risk" | stated the behaviour change in implementation terms ("without a literal `import(`") | Restated semantically: only explicitly deferred/lazy routes are preloadable |
| `Route()` error-node diagnostic | no comment distinguishing a diagnostic source read from preload authority | Comment added, matching the loading-spinner site |

### What was already clean

Re-checked by search rather than assumed. The CHANGELOG sentence about a direct
`AsyncComponent` having "nothing to preload without instantiating", and the
matching `router.md` paragraph, were both already removed — the first when
LOAD-003 was fixed, the second in the LOAD-004 pass. `router.md` and
`async-ownership.md` already carried the final contract.

### Cosmetic `Function#toString()` reads — kept, by design

Two remain in `Route()`, both now carrying an explicit comment:

| Site | Purpose | Grants execution permission? |
|---|---|---|
| error node `data-component-source` | extracts an import path to display on a route error | **no** |
| loading-spinner `isAsync` guess | decides whether to show a spinner while loading | **no** |

The forbidden invariant is *source text → permission to execute a component
during preload*, not *source text → cosmetic or debug hint*. Neither site is
consulted by `isDeferredModule()`.

### Documentation regression check — not added

The repository has no test that reads `.md` files (`documented-limits.test.ts`
pins behaviour against docs, but asserts on runtime, not text). Per the brief,
a search-based assertion was only to be added if such checks already existed, so
none was introduced.

The invariant is pinned behaviourally instead, which is stronger than a text
search: the LOAD-004 false-positive tests fail if source text ever regains
preload authority.

## Final documentation report

```text
RUNTIME

Explicit lazy marker is sole preload authority:     YES
Function#toString used for preload permission:      NO
AsyncFunction used for preload permission:          NO
Direct factories invoked during preload:            NO

DOCUMENTATION

preloadPlan JSDoc stale AsyncComponent wording:     REMOVED
CHANGELOG stale AsyncComponent preload wording:     REMOVED (already, re-verified)
router.md final preload contract:                   VERIFIED
async-ownership final preload contract:             VERIFIED
historical findings clearly past-tense:             VERIFIED
source comments consistent with final architecture: VERIFIED
```

```text
TypeScript source errors:  0
TypeScript test errors:    0
Lint:                      clean (574 files)
Loader/preload tests:      147 passed, 5 files
Full suite:                4602 passed, 1 skipped, 371 files (unchanged)
```
