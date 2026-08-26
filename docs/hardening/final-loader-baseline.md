# Component-Loader Correction — Baseline

Recorded **before** any production-code change in this third, narrowly-scoped
pass. Continues from
[final-router-hardening-baseline.md](./final-router-hardening-baseline.md).

## Repository state

| Item | Value |
| --- | --- |
| Commit | _not a git repository_ — `git rev-parse` fails; the working tree is the only reference point |
| Version | `4.0.0-rc.1` (still unpublished — `npm view sibujs@4.0.0-rc.1` → 404) |

## Gate results

| Gate | Command | Baseline |
| --- | --- | --- |
| Full unit/integration suite | `npx vitest run` | **4570 passed, 1 skipped (4571), 370 files** — green |
| Router suite | router/route/fuzz/split/ssr-route files | **492 passed, 31 files** — green |
| ComponentLoader suite | `routeLoader*`, `router-lazy` | **19 passed, 3 files** — green |
| Route/Outlet suite | `router-hardening-outlet-ownership`, `router.nested*`, `router-hardening-ownership` | **27 passed, 4 files** — green |
| Browser matrix | `npx playwright test --list` | **192 tests, 6 files** (Chromium/Firefox/WebKit) |
| Soak | `npm run test:soak` | **21 passed, 1 skipped (22), 2 files** — green |
| Source typecheck | `npx tsc --noEmit` | **0 errors** |
| Test typecheck | `npx tsc -p tsconfig.test.json` | **0 errors** |
| Lint | `npx biome check src/ tests/` | **clean** — 573 files |
| `certify:rc` | `node scripts/certify/run.mjs` | **ALL REQUIRED GATES PASSED** — 12 PASS / 0 FAIL / 1 NOT TESTED (Node 22.3.0 floor: no interpreter on this host) |

## Scope

Only the route-component **loading / instantiation model** inside
`ComponentLoader`. Nothing else.

### Explicitly preserved (approved, not touched)

Route/Outlet/KeepAlive generation ownership · Suspense lifecycle ownership ·
RouterLink active matching · RouterLink external/native behaviour · unsafe target
neutralization · navigation target classification · redirect validation · data
layer · SSR/hydration/islands · Node support.

## The probe architecture, confirmed from source

`ComponentLoader` validates by **invoking user component factories before the
router intends to mount anything**.

**Synchronous path — `doLoadComponent()`:**

```ts
const result = (comp as Component)();          // user code runs
if (this.isThenable(result)) { … }
if (!this.isElement(result)) throw …
dispose(result as unknown as Node);            // added in the previous pass
return comp as Component;                      // caller invokes comp() AGAIN
```

**Async / lazy path — `awaitComponent()`:**

```ts
const result = await pending;
const component = this.extractComponent(result, routePath);
const testElement = component();               // user code runs
if (!this.isElement(testElement)) throw …
dispose(testElement as unknown as Node);       // added in the previous pass
return component;                              // caller invokes component() AGAIN
```

**`extractComponent()`** collapses a resolved `Element` into a reusable factory:

```ts
if (this.isElement(result)) {
  return () => result;      // one instance becomes a cached, reusable factory
}
```

### Consequences to reproduce

For a direct `AsyncComponent = () => Promise<Element>` the three pieces compose
into an active correctness bug:

```text
AsyncComponent resolves Element E
      ↓
extractComponent(E)  →  () => E          (instance disguised as a factory)
      ↓
component()          →  E
      ↓
dispose(E)                                (probe disposal — from the previous pass)
      ↓
componentCache stores () => E             (cached forever)
      ↓
Route mounts E                            (an already-disposed Element)
```

The probe-disposal line was added in the previous pass to stop the probe node
leaking. On the synchronous and lazy-module paths the probe node is genuinely
discarded, so disposing it is correct. On the **direct `AsyncComponent`** path
the probe node *is* the Element that will later be mounted — so that change
converted a leak into a live defect. Both are consequences of the same root
cause: speculative instantiation.

### Suspected findings

| ID | Area | Suspected severity |
| --- | --- | --- |
| LOAD-001 | Speculative validation invokes user component factories twice | P1 |
| LOAD-002 | Direct `AsyncComponent` Element disposed before mount, then cached and reused | P1 |
| OUT-004 (revised) | Root cause is the validation-probe architecture, not the missing `dispose()` | P1 |
