# Final pre-RC findings

The last gap-closure pass before tagging a release candidate. Seven items were
open; each is now closed, decided, or explicitly deferred with a reason.

Companion documents: [`stable-preflight-findings.md`](stable-preflight-findings.md)
(NODE-001/002 and the type burn-down),
[`rc-certification.md`](rc-certification.md) (the full certification run),
[`../support-matrix.md`](../support-matrix.md) (evidence-based environment support).

## Summary

| ID | Severity | Status | Decision |
|---|---|---|---|
| NODE-FLOOR-001 | P1 | **Closed** | Node 22.3.0 executed exactly; boundary proved against 22.2.0 |
| SEMVER-001 | P1 | **Closed** | Next release planned as **4.0.0**, entering validation as `4.0.0-rc.1` |
| TYPES-NODE-001 | P2 | **Closed** | `@types/node` aligned to `^22.20.1`, matching the runtime floor |
| LOCK-001 | P3 | **Closed** | **COMMIT LOCKFILE** — CI restored to `npm ci` |
| BENCH-001 | P3 | **Open by decision** | **BENCHMARK GATE INFORMATIONAL ONLY** — baseline refreshed, threshold unusable on a shared host |
| TYPE-002 | P2 | **Fixed** | 25 constraint sites widened; blocked legitimate usage |
| TYPE-009 | P3 | **Fixed** | Additive overload |
| TYPE-010 | P3 | **Partially fixed** | `bindField` generic; multi-select residual deferred |
| TYPE-006 | P3 | **Deferred** | Lives in `src/build/`, needs owner sign-off |
| FLAKE-001 | P3 | **Fixed** | Load-sensitive stress tests given consistent timeouts |

No open P0. No open P1.

---

## NODE-FLOOR-001 — the declared minimum is now executed

```text
Status:    CLOSED
Severity:  P1 (an unverified floor is an unsupported floor)
```

**Evidence.** `engines.node` was `>=22.3.0` while CI executed only *current*
22.x and 24.x. Testing "22 latest" does not verify 22.3.0.

Official Node 22.3.0 and 22.2.0 builds were downloaded, SHA-256 verified against
`SHASUMS256.txt`, and added to the matrix as an **exact** target
(`--versions=22.3.0,22,24`).

**Result — 15/15 gates on all three targets:**

| Gate | 22.3.0 | 22.14.0 | 24.19.0 |
|---|---|---|---|
| install · build | PASS | PASS | PASS |
| source typecheck · test typecheck (0 errors) | PASS | PASS | PASS |
| unit suite (4 390 tests) | PASS | PASS | PASS |
| `npm pack` | PASS | PASS | PASS |
| ESM import — 15 subpaths | PASS | PASS | PASS |
| CJS require — 15 subpaths | PASS | PASS | PASS |
| DOM-less router construction (RC-001) | PASS | PASS | PASS |
| DOM-less memory-router navigation (NODE-001) | PASS | PASS | PASS |
| query clean exit (RC-002) | PASS | PASS | PASS |
| SSR request isolation — ESM | PASS | PASS | PASS |
| SSR request isolation — CJS | PASS | PASS | PASS |
| SSR streaming smoke | PASS | PASS | PASS |
| promise-returning route component (RC-003) | PASS | PASS | PASS |

**Boundary proof.** The floor exists because `process.getBuiltinModule` — the
only synchronous way to load a builtin from ESM — arrived in Node 22.3.0.
Measured directly rather than inferred:

```text
node 22.2.0  getBuiltinModule=undefined  isolated=false  → UNSUPPORTED
node 22.3.0  getBuiltinModule=function   isolated=true   → SUPPORTED
node 22.14.0 getBuiltinModule=function   isolated=true   → SUPPORTED
node 24.19.0 getBuiltinModule=function   isolated=true   → SUPPORTED
```

Every probe verified the two requests genuinely interleaved
(`A:start B:start B:done A:resume`) before asserting isolation, so a pass is a
measurement rather than a vacuous result. The probe also exits non-zero if
capability and behaviour ever *disagree*, which would mean the documented
rationale for the floor is wrong.

Reproduce: `node scripts/certify/node-probes/engine-floor.mjs` on any build.
`tests/engine-floor.test.ts` pins the same capability in the normal suite —
as documentation, not runtime branching. Nothing in the framework tests a
version string; detection is by capability.

**Two things this pass found only because the exact floor was executed:**

1. The matrix probe installed `jsdom@latest`, which resolved a transitive
   `html-encoding-sniffer` that `require()`s an ES module — a Node ≥ 22.12
   feature. The probe failed on 22.3.0 and reported the *framework* as broken at
   its own floor. The probe now pins jsdom to the version this repository
   develops against. A tooling dependency must never dictate the published
   runtime floor (§11/§12).
2. FLAKE-001, below.

**Remaining risk.** CI executes the declared minimum and the current 22/24
lines. It cannot execute every patch release in the range, and the support
documentation says so rather than claiming otherwise.

---

## SEMVER-001 — the engine change is a major version

```text
Status:    CLOSED
Severity:  P1 (mis-versioning a compatibility break)
```

Supported Node moved `>=18.0.0` → `>=22.3.0`. Under Semantic Versioning that is
breaking regardless of source-level changes: an install that worked yesterday
fails `engine-strict` today.

**Decision: the next release is 4.0.0**, entering real-world validation as
**4.0.0-rc.1**. Publishing this as `3.4.x` or `3.5.x` would be wrong.

`package.json` is deliberately **left at `3.4.1`** — this repository versions at
release time, not in feature commits (§7). The requirement is recorded in
`CHANGELOG.md`, which now opens with `## [Unreleased] — targeting 4.0.0`, labels
the engine change under `### Breaking`, and carries a `### Migration to 4.0`
section.

**Engine metadata verified to signal correctly** on an unsupported runtime:

```text
Node 20, default npm      npm warn EBADENGINE  required: { node: '>=22.3.0' }
                          → install proceeds (npm's default policy)
Node 20, engine-strict    npm error code EBADENGINE
                          → install fails
```

**Migration impact:** none beyond the Node upgrade. No public API was removed or
renamed. The four type changes below all *widen* what compiles, so code that
built against 3.x still builds.

---

## TYPES-NODE-001 — type definitions aligned to the runtime floor

```text
Status:    CLOSED
Severity:  P2
```

`@types/node` was `^25.5.0` while the runtime floor is 22.3. Typing against Node
25 lets TypeScript silently accept an API the minimum runtime does not have —
the same class of mismatch as an unverified engine claim.

**Evidence.** The source uses a small Node surface: `node:async_hooks`,
`node:fs`, `node:path`, and `process.env` / `versions` / `getBuiltinModule` /
`cwd`. Compiled against `@types/node@22.20.1`:

| Check | Result |
|---|---|
| `tsc --noEmit` (source) | clean |
| `tsc -p tsconfig.test.json` | 0 errors |
| `npm run build` | clean |
| Full suite | 4 390 passing |

**Decision:** pinned to `^22.20.1`. Not downgraded blindly — verified first, and
`getBuiltinModule` is present in the Node 22 definitions, so the detection code
still type-checks precisely.

**Framework runtime and tooling runtime are documented separately.**
Certification scripts under `scripts/certify/**` are plain `.mjs`, are not
type-checked against this package, and run on whatever Node the contributor has.
They do not constrain the published runtime.

---

## LOCK-001 — COMMIT LOCKFILE

```text
Status:   CLOSED
Decision: COMMIT LOCKFILE
```

`package-lock.json` was gitignored, so a fresh checkout had no lockfile: `npm ci`
could not run, and `actions/setup-node`'s npm cache had no key. CI therefore
re-resolved transitive dev dependencies on every run and certified a dependency
set nobody chose.

**Trade-off.** A library's lockfile does not affect consumers — npm resolves
their tree from `package.json` ranges, not from ours. What it affects is *this
repository's own reproducibility*: whether a certification result can be
reproduced later, and whether a transitive release can change what CI tested
without any commit here. NODE-FLOOR-001's jsdom incident is a concrete example
of a floating dev dependency changing an outcome.

**Verified (§17):**

| Check | Result |
|---|---|
| Lockfile appears in the published tarball | **No** — 113 entries, `dist/` + README + LICENSE + package.json |
| Fresh tree, `npm ci` | PASS |
| `typecheck:tests` **before** any build | PASS — 0 errors |
| source typecheck · build · lint | PASS |
| Full suite from the `npm ci` tree | PASS — 4 390 tests, 363 files |

CI restored to `npm ci --no-audit --no-fund` with `cache: npm` in both jobs.

---

## BENCH-001 — BENCHMARK GATE INFORMATIONAL ONLY

```text
Status:   OPEN BY DECISION
Decision: BENCHMARK GATE INFORMATIONAL ONLY
```

The previous baseline was two months stale and reported 21 false regressions on
an untouched tree, so it was never a usable gate.

**It has been re-recorded** on the current commit and toolchain, with the
environment captured in `bench-baseline.meta.json` (commit, Node, npm, OS, CPU,
core count, RAM, jsdom version, benchmark count). So the baseline is no longer
stale.

**The gate is still not usable, and this was measured rather than assumed.**
Three consecutive `bench:check` runs against that *freshly recorded* baseline,
same host, same commit:

| Run | Regressions reported at the 20 % threshold |
|---|---|
| 1 | 1 |
| 2 | 1 — `1,000 updates WITH batch`, +26.5 % |
| 3 | 2 — `Create 100,000 signals` +33.0 %, `1,000-deep computed chain` +21.7 % |

Different benchmarks each time. That is measurement noise on a shared developer
laptop, not regression, and a gate that fires randomly is worse than no gate.

**Neither of the two canned outcomes fits exactly** — the baseline is refreshed,
but the gate is not usable — so the honest report is the second one:
**INFORMATIONAL ONLY**. Reporting PASS on a stale or noisy comparison would be
exactly the overclaim this pass exists to remove.

**To make it a real gate**, re-record on the host where it will be enforced
(a dedicated runner, or CI with pinned hardware) and raise the threshold until
three consecutive no-change runs are clean. No performance work was done in this
pass (§20); if the refreshed baseline later shows a genuine slowdown, that is a
separate investigation.

---

## Declaration gaps reviewed in the major-version window (§13/§14)

The four gaps deferred by the previous pass were re-examined, because a major
release is the right moment and widening a type is backwards-compatible. The
test was §14's: does the current contract *block legitimate usage*,
*misrepresent runtime behaviour*, or *create dangerous inference*?

### TYPE-002 — FIX

**Blocked legitimate usage.** Six user-facing generics were probed with a
consumer-style type test and all six rejected an `interface`:

```text
machine<S, E, Ctx>            Type 'Ctx' does not satisfy 'Record<string, unknown>'
defineComponent<Props>        Type 'Props' does not satisfy ...
createSharedScope<Shared>     Type 'Shared' does not satisfy ...
wasm<WasmExports>             Type 'WasmExports' does not satisfy ...
withDefaults<Props>           Type 'Props' does not satisfy ...
validateProps<Props>          Type 'Props' does not satisfy ...
```

An `interface` has no implicit index signature; a `type` alias does. So the
identical shape compiled or failed depending on which keyword declared it, while
the runtime always accepted both.

**25 constraint sites across 13 files widened to `T extends object`.** Source
type-checks clean with **no internal casts required** — none of the
implementations ever needed the index signature. Backwards-compatible: the
constraint accepts strictly more, so nothing that compiled against 3.x stops.

### TYPE-009 — FIX

`copyOnClick` is `ActionFn<(() => string) | undefined>` — its text getter is
optional — but the two-argument `action()` overload demanded `ActionFn<void>`, so
`action(el, copyOnClick)` did not compile despite being the documented usage and
exactly what the runtime does. Fixed with one **additive** overload; the
three-argument form is untouched.

### TYPE-010 — PARTIAL FIX

`bindField()` documents itself as returning props "ready to pass directly to a
tag factory", but returned `value: () => unknown`, which does not satisfy the
typed factories' `reactive<string>` — the declaration contradicted the
documentation. `BoundFieldProps` is now generic over the field's value type
(defaulting to `unknown`, so existing annotations still compile), and
`bindField` preserves it.

A single-value field now spreads onto a tag factory **with no cast at all**.

**Residual, deliberately deferred:** a `<select multiple>` binds `string[]` while
`SelectProps.value` is `reactive<string>`. Modelling multi-select in the
tag-factory prop types touches `tagPropTypes` and every factory — a wider change
than this window justifies. The one remaining cast is scoped to that case and
carries a pointer here.

### TYPE-006 — DEFER

`generateEslintConfig()` returns `Record<string, unknown>`, so every property
read is `unknown`. It lives in `src/build/`, which is off-limits without owner
sign-off, and it is build-time tooling rather than framework runtime. The test
narrows through a declared `EslintConfigShape` interface instead.

### Migration tests (§15)

`tests/types/public-api-contract.test.ts` gained three cases covering every
changed API: that the **new** style compiles (a plain `interface`,
`action(el, copyOnClick)`, a typed `bindField`), and that the **old** style still
compiles (an interface explicitly extending the index signature, the
three-argument `action`, the bare `BoundFieldProps`). Negative cases stay
`@ts-expect-error`, which fails if the error ever stops occurring.

---

## FLAKE-001 — load-sensitive stress tests

```text
Status:   FIXED
Severity: P3
```

`tests/hardening.test.ts` failed on Node 22.14 during a matrix run with a 5 s
timeout on "appends 5,000 items to 5,000-item list". Re-run twice on a quiet
host: **25/25 both times.** Machine load, not a defect, and not
version-specific — it passed on 22.3.0 and 24 in the same run.

These cases assert **correctness over large lists, not throughput**, so a
default 5 s budget only produces false CI failures. A sibling test in the same
block already carried `15_000`; the rest of the block now matches it rather than
inventing a new policy.

---

## Reference application plan (§28)

Automated certification and production use are different evidence layers.
Before the classification moves past PRODUCTION-HARDENED CANDIDATE, the RC needs
sustained real use across three profiles — **real applications, not fixtures**:

| Profile | Exercises | Watch for |
|---|---|---|
| **Client-only** | reactivity, keyed lists, router, disposal over long sessions | uncaught browser exceptions, memory growth across navigations, router/history divergence, listener counts |
| **SSR** | request isolation under genuine concurrency, hydration, streaming | cross-request data bleed, SSR latency and its tail, hydration mismatches, process exit behaviour |
| **Data-heavy** | query cache, invalidation, mutations, refetch under churn | stuck `fetching` flags, cache growth, retry storms, unhandled rejections |

The SSR profile is the one that matters most: NODE-002 was a silent
cross-request bleed that no unit test caught, and its fix is now guarded by a
runtime warning — production is where that warning either stays quiet or does
not.

Report back with: uncaught exceptions, browser errors, memory over time, router
failures, query-cache behaviour, SSR latency, SSR request isolation, and process
exit behaviour.

---

## What changed in `src/` during this pass

| File(s) | Change | Finding |
|---|---|---|
| 13 files, 25 sites | `extends Record<string, unknown>` → `extends object` | TYPE-002 |
| `src/core/rendering/action.ts` | Additive overload for optional-param actions | TYPE-009 |
| `src/ui/form.ts` | `BoundFieldProps<T>`; `bindField` preserves the field type | TYPE-010 |

All three are **type-only widenings**. No runtime behaviour changed in this pass
(§37). The runtime fixes referenced throughout — NODE-001, NODE-002, RC-001/2/3
— landed previously and are re-verified here at the exact floor.
