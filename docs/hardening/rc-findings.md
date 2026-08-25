# Release-candidate certification — findings

Every entry here was reproduced before being classified, and every framework fix
landed only after a failing test existed. Nothing in this document is a
static-inspection suspicion.

Severity: **P0** critical · **P1** high · **P2** medium · **P3** low.
`TEST-*` entries are defects in the *test suite or the certification harness*,
tracked separately per §86 because a test that passes vacuously is as dangerous
as no test at all — several were found in harnesses written during this very
pass.

## Summary

| ID | Severity | Subsystem | Status | Summary |
|---|---|---|---|---|
| RC-001 | **P1** | Router | **Fixed** | Constructing a router without a DOM crashed the process from a microtask — uncatchable |
| RC-002 | **P2** | Data layer | **Fixed** | Query GC timer pinned the Node event loop for 5 minutes after the work finished |
| RC-003 | **P2** | Router | **Fixed** | A promise-returning route component was dropped unawaited, leaking an unhandled rejection |
| PKG-001 | P3 | Packaging | Open | `./package.json` is not an exports subpath |
| PKG-002 | P2 | Packaging | Open | CJS output duplicates the whole runtime into all 15 entries (2.18× ESM size) |
| PKG-003 | P3 | Packaging | Open (by design) | `sibujs/plugins` aggregates i18n with the router; router-only bundles carry i18n |
| TEST-001 | — | Harness | Fixed | `typeof window` tripwire produced 3 false failures |
| TEST-002 | — | Harness | Fixed | SSR tree-shaking marker was mis-attributed to a core module |
| TEST-003 | — | Harness | Fixed | `retry: 0` silently meant "3 retries", masking the state under test |
| TEST-004 | **P2** | Test infra | Open | `tests/` was never type-checked — 130 pre-existing type errors |
| TEST-005 | — | Harness | Fixed | Router fuzz was vacuous (no outlet ⇒ no component loads) plus two wrong invariants |
| TEST-006 | — | Harness | Fixed | Regex-based XSS assertion manufactured the pattern it searched for |
| TEST-007 | P3 | Test infra | Open | `npm test` is not hermetic — 31 tests fail without a prior `npm run build` |

Three confirmed framework bugs, all fixed. **No P0. No unresolved P1.**

---

## RC-001 — Router construction crashes any DOM-less runtime

```text
ID:         RC-001
Severity:   P1
Subsystem:  Client router (src/plugins/router.ts)
Status:     FIXED
```

**Description.** `SibuRouter.initialize()` guards its event-listener
registration with `typeof window !== "undefined"`, carrying an explicit comment
that this is "so constructing a router under SSR (e.g. `createMemoryRouter`,
advertised for testing/SSR) doesn't throw on `window`". The `queueMicrotask`
bootstrap immediately below that guard was **not** guarded. It called
`handleLocationChange()` → `getCurrentPath()`, which read `window.location`
bare.

The constructor therefore returned normally and the process died a microtask
later. Because the throw originates in a microtask, it is an **uncatchable**
`ReferenceError`: a `try`/`catch` around the call site cannot intercept it, and
under Node's default policy it terminates the process.

`createMemoryRouter` — which the source documents as being for "testing/SSR" —
was affected in hash mode via the same path, i.e. it was broken in precisely the
environment it advertises.

**Reproducer.** Bare Node, no DOM, against the *packed* package:

```js
import { createMemoryRouter } from "sibujs/plugins";
const r = createMemoryRouter([{ path: "/", component: () => null }], "/");
console.log("returned OK", r.currentPath());   // prints
setTimeout(() => console.log("survived"), 100); // never reached
// → UNCAUGHT: ReferenceError - window is not defined   (exit 7)
```

**Why it survived every prior router pass.** The entire router suite runs under
jsdom, where `window` always exists. No test had ever constructed a router in a
genuinely DOM-less runtime.

**Root cause.** `getCurrentPath()` read `window.location.*` with no environment
guard, on a code path reachable from the constructor.

**Fix.** `src/plugins/router.ts` — `getCurrentPath()` returns `"/"` when
`typeof window === "undefined"`, matching the route `createInitialRoute()`
already seeds. Browser behaviour is byte-identical.

**Regression test.** `tests/router-domless.test.ts` — 5 tests under
`// @vitest-environment node`, so `window` is genuinely absent rather than
stubbed. Includes a guard asserting the environment premise itself.

**Remaining risk.** Low. `go()`/`back()`/`forward()` still call `history.*`
unguarded, and `handleScrollBehavior` uses `requestAnimationFrame`/
`window.scrollTo`. Those are explicit user calls on a client-only API rather
than something the constructor reaches, so they were left alone under the
feature freeze. They are recorded in the caveat list.

---

## RC-002 — Query cache GC timer pins the Node event loop

```text
ID:         RC-002
Severity:   P2
Subsystem:  Data layer (src/data/query.ts)
Status:     FIXED
```

**Description.** When the last observer detaches, `detachFromEntry()` schedules
a `setTimeout` for `cacheTime` (default **300 000 ms**) to collect the entry.
The retention window is correct and intentional. The timer being **ref'd** was
not: in Node it holds the event loop open for the full five minutes after the
work is done.

Consequences: a static-site build, a CLI, a script, or a serverless invocation
that merely touched `query()` hangs for five minutes after printing its output.

**Reproducer.** Surfaced by the bundler matrix, where every `data-only` probe
produced correct output and then failed the 15-second exec timeout:

```text
$ node out/data-only.esbuild.js
SIBU_PROBE data-only OK afterFetch=fetched afterWrite=overwritten
EXIT=124   (still running after 20s)

$ node -e "... q.dispose(); process.getActiveResourcesInfo()"
active resources after dispose: ["Timeout"]
```

**Why it survived.** The whole data-layer suite runs under jsdom, where timer
handles have no `unref` and the runner tears the environment down regardless.
`unref()` appeared nowhere in `src/`.

**Fix.** `src/data/query.ts` — `(entry.gcTimer).unref?.()` after scheduling.
This changes only whether the timer holds the process alive, never when it
fires. The optional call covers browsers, whose handles have no `unref`.

Deliberately **not** applied to the retry backoff, `refetchInterval`, debounce,
or throttle timers: each of those represents work a caller is actively awaiting
or an explicitly requested poll, and un-ref'ing them would be a behaviour change
rather than a fix.

**Regression test.** `tests/query-timer-unref.test.ts` — asserts the scheduled
handle reports `hasRef() === false`, that the runtime actually has unref-able
timers (premise guard), and that collection still happens on schedule.

**Verified end-to-end.** All 12 bundler-matrix probes now exit cleanly; "clean
exit" is a permanent gate in `scripts/certify/bundler-matrix.mjs`.

---

## RC-003 — Promise-returning route components are dropped unawaited

```text
ID:         RC-003
Severity:   P2
Subsystem:  Client router (ComponentLoader)
Status:     FIXED
```

**Description.** The exported public type is
`AsyncComponent = () => Promise<Element>`, and `AsyncRoute.component` accepts
it. The runtime, however, classified components **syntactically**:
`isAsyncComponent()` recognised only the `lazy()` marker, a genuine
`async function`, and a source string containing `import(`.

A component written as `() => new Promise(...)` or
`() => fetchThing().then(...)` matched none of those and took the *synchronous*
path:

```ts
const result = comp();                 // a Promise, not an Element
if (!this.isElement(result)) throw new Error(`... must return Element`);
```

Two user-visible consequences:

1. the route failed with a misleading `must return Element, got object`;
2. the promise was discarded with **no handler attached**, so a later rejection
   escaped as an unhandled rejection — fatal to a Node process under the default
   policy, and noise in every browser error reporter.

**Reproducer.** Both with and without supersession:

```text
CASE A rejections: ["A-failed"]   (component is the live owner — still leaks)
CASE B rejections: ["B-failed"]   (superseded first — also leaks)
```

**Root cause.** A syntactic heuristic used where a structural check was needed;
the mismatch left a promise with no owner.

**Fix.** `src/plugins/router.ts` — the sync branch now detects a thenable result
and adopts it via a shared `awaitComponent()` helper (extracted from the
existing async branch, so both paths validate identically). The branch
previously always threw, so nothing can regress.

**Regression test.** `tests/router-async-component.test.ts` — 4 tests covering
render, rejection while owner, rejection after supersession, and a
counter-test proving a genuinely invalid component (returns `42`) is still
rejected, so the fix did not over-broaden.

---

## PKG-001 — `./package.json` is not an exports subpath

```text
Severity: P3 · Subsystem: Packaging · Status: OPEN
```

`require.resolve("sibujs/package.json")` and
`import("sibujs/package.json")` both fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
Bundler plugins, framework integrations, and tooling routinely read a package's
manifest this way. The conventional remedy is one line in `exports`:

```json
"./package.json": "./package.json"
```

Not applied during the freeze — it is an additive packaging change, and the
release owner should decide whether to ship it in this RC or the next minor.

## PKG-002 — CJS output duplicates the runtime into every entry

```text
Severity: P2 · Subsystem: Packaging · Status: OPEN (correctness unaffected)
```

`tsup` code-splits the ESM output but not the CJS output. Measured:

| Format | Files embedding the reactive core | Total bytes |
|---|---|---|
| ESM | **1 of 15** (`chunk-BQLVTAUZ.js`, shared) | 729 477 |
| CJS | **15 of 15** | 1 592 789 (**2.18×**) |

Every CJS consumer that requires two or more subpaths therefore loads N copies
of the runtime and sees this on stderr:

```text
[SibuJS] Multiple instances of the reactive runtime detected on this page
(active: 3.4.1, duplicate: 3.4.1). Reactivity still works — all copies share
the first one — ...
```

**Correctness is not affected, and this was verified rather than assumed.** The
`Symbol.for` registry architecture does exactly what it claims: a cross-copy
probe against the packed tarball confirmed that an `effect` from `sibujs`
observes a signal owned by `sibujs/data`, that `batch()` from one copy coalesces
writes tracked by another, and that a `setQueryData` through a third copy lands
on the first copy's cache entry in both directions.

What remains is real but bounded: wasted bytes and a warning that will be
reported as a bug by CJS users. Worth revisiting with `splitting: true` for CJS
in a subsequent minor.

## PKG-003 — `sibujs/plugins` aggregates i18n with the router

```text
Severity: P3 · Subsystem: Packaging · Status: OPEN (by design)
```

`plugins.ts` re-exports i18n, router, routerSSR, plugin, modular, ecosystem,
versioning, and startup from one entry. A bundle importing only `createRouter`
retains the i18n registry in all four bundlers tested. This is the "public
entrypoints intentionally aggregate modules" case, not a tree-shaking failure —
core, data, and SSR isolation are all clean (see the tree-shaking table in
`rc-certification.md`). Documented so the trade-off is explicit rather than
surprising.

---

# Test-suite and harness defects

## TEST-001 — `typeof window` tripwire produced false failures

The first revision of `scripts/certify/exports-audit.mjs` defined a throwing
getter for `window` to detect browser-global access at import time. It reported
`./performance`, `./plugins`, and `./extras` as failing with
`ReferenceError: window is not defined`.

All three were **false**. `typeof window === "undefined"` is the *correct*
environment guard, but `typeof` invokes a defined getter, whereas a genuinely
absent global short-circuits. Bare Node imports all 16 subpaths cleanly —
verified without instrumentation before any conclusion was drawn.

**Fixed:** the tripwire no longer synthesises browser globals. The faithful
check is simply whether a bare-Node import throws.

## TEST-002 — SSR tree-shaking marker mis-attributed

`bundler-matrix.mjs` used `Symbol.for("sibujs.ssr.v1")` as the "SSR renderer
present" marker and consequently reported an SSR leak into *every* probe,
including core-only. That symbol belongs to `src/core/ssr-context.ts` — a core
rendering concern core legitimately carries — not to the renderer in
`src/platform/ssr.ts`.

**Fixed:** the marker is now `data-sibu-suspense-id`, a literal only the
renderer emits. Tree-shaking results changed from 0/12 "clean" to 8/12, with the
remaining 4 being the genuine PKG-003 aggregation.

## TEST-003 — `retry: 0` silently meant three retries

`tests/fuzz-query-model.test.ts` initially passed `{ retry: 0 }`. `RetryOptions`
is an **object**; `options?.maxRetries ?? 3` evaluates `(0)?.maxRetries` to
`undefined`, so the fuzz ran with the default three retries and 1 s exponential
backoff. Rejections never settled within the harness's microtask flushes, and
the fuzz reported a non-existent "observer stuck fetching" bug.

TypeScript **does** reject `retry: 0` — which is how TEST-004 was discovered:
the test file was never type-checked.

**Fixed:** `{ maxRetries: 0 }`.

## TEST-004 — `tests/` was never type-checked

```text
Severity: P2 · Subsystem: Test infrastructure · Status: OPEN
```

`tsconfig.json` has `"include": ["src", "index.ts"]`. Neither the test suite nor
the other 14 subpath entry files were ever passed to `tsc`. Vitest strips types
rather than checking them, so a test could call a public API with the wrong
types and still pass — which is exactly what TEST-003 did.

Enabling type-checking for the first time surfaced **130 pre-existing errors
across ~40 test files**, including tests passing a raw `string` where a branded
`TrustedHTML` is required — i.e. tests exercising APIs in ways the type system
forbids, which weakens what those tests actually prove.

**Partially addressed.** Added `tsconfig.test.json` and
`npm run typecheck:tests`, wired into `certify:rc` as an explicitly
**non-blocking** gate so the number is visible and can be burned down. The 130
errors were **not** fixed: repairing ~40 test files is well outside a
certification pass under feature freeze, and doing it blind risks weakening
assertions. Recommended as the first post-RC cleanup.

All six test files added by this pass are type-clean.

## TEST-005 — Router fuzz was vacuous, plus two wrong invariants

Three separate defects in `tests/fuzz-router-model.test.ts`, all caught before
the file was accepted:

1. **Vacuous.** `navigate()` does not load components — `loadComponent` is only
   reached from the `Route()` outlet. The first version never mounted an outlet,
   so every "settle/fail a pending load" operation was a silent no-op and the
   async-ownership invariants tested nothing. Confirmed by instrumentation:
   `loads = 0` after a full run.
2. **Wrong invariant (guards).** Asserting `guardMode === "reject" ⇒ path !== "/guarded"`
   continuously is false: `beforeEnter` runs on *entry*, so flipping the mode
   while already on the route is not a violation.
3. **Wrong invariant (ownership).** Two formulations were tried and both were
   wrong — "the outlet always shows `router.currentRoute`" (false: the outlet
   deliberately keeps the previous element while the next loads) and "committed
   load ids never decrease" (false: `ComponentLoader` caches a component per
   route, so an older id legitimately reappears on back-navigation).

**Fixed.** The file now mounts a real outlet; asserts the guard contract at the
point of navigation; asserts the invariant the router actually promises (the
outlet replaces rather than accumulates, plus terminal router/outlet
consistency); and carries **per-seed and suite-level vacuity guards** that fail
if async loads, async commits, or guard rejections were never exercised.

A fourth vacuity trap was caught the same way in `tests/soak/ssr.soak.ts`: the
concurrent-isolation test ran `query()` inside `runInSSRContext` and checked for
cross-request bleed, but `query()` never fetches under SSR (effects are
suppressed), so **0 of 1 000** requests ever resolved and the bleed filter had
nothing to reject. Rewritten to assert the real isolation mechanism — distinct
cache-map identity per concurrent request, and per-request suspense id
sequences.

## TEST-006 — XSS assertion manufactured the pattern it searched for

The SSR security fuzz first asserted "no event-handler attribute" by stripping
HTML entities from the output and regex-matching `\son[a-z]+\s*=`. An escaped
payload such as `&quot; onmouseover=&quot;alert(1)` is completely inert, but
decoding it *creates* the exact string being searched for. Three false failures.

**Fixed.** `assertInert()` now **parses** the output and inspects the resulting
DOM — no element outside an expected allowlist, no attribute whose name starts
with `on`, no URL attribute carrying an executable scheme. Parsing is
authoritative because it is what a browser does.

Two further adjustments were needed to separate HTML's own behaviour from
SibuJS's: a raw `NUL` has no representation in serialized HTML (a conforming
parser yields `U+FFFD` or drops it) and the input-stream rules fold `CRLF` and
lone `CR` to `LF`. Both are normalised out of the *fidelity* comparison only —
the security assertions still run against NUL- and CR-bearing payloads.

## TEST-007 — `npm test` is not hermetic

```text
Severity: P3 · Subsystem: Test infrastructure · Status: OPEN
```

`tests/consumption.test.ts` reads real files from `dist/`. On a clean checkout
with no prior build, **31 tests fail** with
`ENOENT: ... dist\cdn.global.js` — verified directly by moving `dist/` aside.

This is invisible day to day because a developer has usually built at least
once, and it made the first `certify:rc` run report a spurious suite failure
after a preceding gate left `dist/` incomplete (`npm run build` starts with
`--clean`).

Not fixed: the remedy is a policy choice between gating those tests on `dist/`
existing and declaring `npm run build` a documented prerequisite. `certify:rc`
now runs Build before the suite, and the ordering is commented as load-bearing.
