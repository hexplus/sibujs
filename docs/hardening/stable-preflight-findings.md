# Stable-release preflight — findings

Two gaps were open after RC certification: the declared Node range had never
been executed, and the test suite had 130 TypeScript errors. Both are closed.
Everything below was reproduced before being classified, and every fix landed
behind a failing check.

## Summary

| ID | Severity | Area | Status | Summary |
|---|---|---|---|---|
| NODE-001 | **P1** | Router | **Fixed** | Every navigation failed in a DOM-less runtime — `createMemoryRouter` could be constructed but never navigated |
| NODE-002 | **P1** | SSR / AsyncLocalStorage | **Fixed (CJS) · support narrowed (ESM)** | Request isolation silently unavailable below Node 22.3; the CJS fallback never worked on any version |
| TYPE-001 | P2 | `eventBus`, `normalize` | **Fixed** | An `interface` was rejected by `Record<string, unknown>` constraints |
| TYPE-003 | P3 | `RouterLink` | **Fixed** | Declared `HTMLElement`; reading back `.target`/`.rel` did not compile |
| TYPE-007 | P2 | `globalStore` | **Fixed** | Action constraint made typed payloads impossible and collapsed `dispatch` to `unknown` |
| TYPE-008 | P2 | Test suite | **Fixed** | A disposal test subscribed to nothing and asserted trivially |
| TYPE-002 | P3 | ~20 public generics | Open | Same constraint pattern as TYPE-001, no test coverage to confirm |
| TYPE-006 | P3 | `generateEslintConfig` | Open | Returns `Record<string, unknown>`; lives in `src/build/` |
| TYPE-009 | P3 | `action()` | Open | Two-arg overload rejects an action with an optional param |
| TYPE-010 | P3 | `bindField()` | Open | Documented as "pass directly to a tag factory"; the types disagree |
| CI-001 | P3 | CI | Open | No committed lockfile, so `npm ci` and the setup-node cache cannot be used |

Two P1s, both found by running Node versions CI had never executed. **No
unresolved P0/P1 remains.**

Full type-error categorisation: [`test-type-errors.md`](test-type-errors.md).

---

## NODE-001 — every navigation fails in a DOM-less runtime

```text
Severity:   P1
Affected:   all Node versions; any runtime without a `history` global
Status:     FIXED
```

**Reproducer.** Bare Node, no DOM, against the packed tarball:

```js
import { createMemoryRouter } from "sibujs/plugins";
const { currentPath, push } = createMemoryRouter(
  [{ path: "/", component: () => null }, { path: "/about", component: () => null }], "/");
await new Promise(r => setTimeout(r, 50));
console.log(currentPath());                 // "/"        — construction fine
console.log(await push("/about"));          // success: false, reason: "error"
//                                             error: "history is not defined"
```

RC-001 made *construction* safe in a DOM-less runtime. Navigation was still
broken, so `createMemoryRouter` — whose own doc comment says it "creates a
router that doesn't interact with browser history", and which the codebase
advertises for testing/SSR — could be constructed and then never used.

**Root cause.** `updateHistory()` referenced the bare `history` global rather
than a guarded one, and `navigate()` reaches it on every non-`skipHistory`
transition. The bootstrap path uses `skipHistory: true`, which is exactly why
RC-001's fix did not cover this.

**Why it survived.** Every router test runs under vitest's jsdom environment,
which installs `history` as a real global. A consumer wiring up jsdom by hand —
the documented way to run SibuJS outside a browser — copies `window` and friends
but has no reason to copy `history`, and hits this on the first navigation.

**Fix.** `src/plugins/router.ts` — `updateHistory()` reads
`globalThis.history` and returns early when it is absent. The route still
commits; only the address-bar side effect is skipped, which is precisely the
intended memory-router semantics.

**Regression test.** `tests/router-domless.test.ts`, three new cases under
`// @vitest-environment node`: memory-router navigation, `push`/`replace`, and a
redirect route. Also exercised against the packed tarball on every Node version
by `scripts/certify/node-probes/domless-router.mjs`.

**Remaining risk.** `router.go()`, `.back()`, and `.forward()` still call
`history.*` unguarded. They are explicit calls to browser-history semantics that
a memory router cannot provide, so they were left alone rather than made to
no-op silently; recorded in the support matrix caveats.

---

## NODE-002 — SSR request isolation silently unavailable below Node 22.3

```text
Severity:   P1 (security-relevant: cross-request data bleed)
Affected:   ESM  — every Node < 22.3
            CJS  — every Node < 22.3 (fallback never worked at all)
Status:     FIXED for CJS · support range narrowed for ESM
```

**Reproducer.** Two interleaved SSR requests must each see their own scope:

```js
import { runInSSRContext, getRequestScopedCache } from "sibujs";
const [a, b] = await Promise.all(["A", "B"].map(() => runInSSRContext(async () => {
  const before = getRequestScopedCache("query");
  await new Promise(r => setTimeout(r, 5));
  return { before, after: getRequestScopedCache("query") };
})));
// Node 18.20.5 / 20.15.1 (ESM): available=false  distinct=false
// Node 22.14.0 / 24.19.0 (ESM): available=true   distinct=true
```

**Root cause — two defects in one detection block.**

`src/core/ssr-context.ts` loads `AsyncLocalStorage` through two branches:

1. `process.getBuiltinModule("node:async_hooks")` — synchronous and ESM-safe,
   but **added in Node 22.3**.
2. A fallback for older Node:
   `Function("return typeof require === 'function' ? require : null")()`.

The fallback **never worked on any version, in either module format**, because
`Function(...)` evaluates its body in *global* scope — and `require` is a
module-local binding in CommonJS, not a global. It returned `null` every time.
ALS was therefore only ever detected via `getBuiltinModule`, i.e. on Node ≥ 22.3.

Below that, `getRequestScopedCache()` returns `null` and every request shares one
module-global store. The source comment above the branch predicted the exact
consequence — *"the per-request SSR scope (flag + query cache) would fall back
to a shared module global — i.e. cross-request data bleed"* — but nothing
executed the path that proved it, because CI ran Node 20 only and the ESM
detection happened to work on the maintainer's Node 24.

A fully **synchronous** render is unaffected: the fallback saves and restores the
store around the call. The bleed requires two requests interleaving across an
`await`, which is what streaming and any async data path do.

**Fix (CJS).** Reference `require` lexically instead of through `Function`:

```ts
} else if (typeof require === "function") {
  mod = require("node:async_hooks") as AHMod;
}
```

In the CommonJS build `require` is in scope and this resolves; in the ESM build
`typeof require` is `"undefined"` and the branch is skipped safely. Verified:
CJS isolation now passes on **18.20.5, 20.15.1, 22.14.0 and 24.19.0**.

**ESM below 22.3 is not fixable in-place.** There is no synchronous way to load
a builtin module from ESM before `getBuiltinModule` existed. A static
`import "node:async_hooks"` would resolve it but breaks every browser bundle,
and the bundler matrix is a shipped guarantee.

**Support decision.** `engines.node` raised from `>=18.0.0` to **`>=22.3.0`** —
the version that actually provides the mechanism. Both dropped lines are already
end-of-life (Node 18 in April 2025, Node 20 in April 2026), and they were the
only versions failing any gate. This is a **breaking change** for anyone still
on EOL Node and belongs in the release notes.

The floor is `22.3.0`, not `22.0.0`, because `getBuiltinModule` landed in 22.3 —
`22.0`–`22.2` would fail the same gate, and a floor that is not backed by
evidence is the problem this pass exists to remove.

**Diagnostic.** The degradation was *silent*, which was the dangerous part.
`runInSSRContext` now warns once, on Node only, when it reaches the fallback:

```text
[SibuJS] SSR request isolation is UNAVAILABLE on this runtime (Node 18.20.5).
AsyncLocalStorage could not be loaded, so concurrent requests share one SSR
store: request state and the query cache can bleed between them. ...
```

Browsers and DOM-less edge runtimes reach the same fallback legitimately and are
not warned.

**Regression tests.** `tests/ssr-hardening-node-env.test.ts` already covered the
ESM contract and was the failing check on 18/20. Added
`scripts/certify/node-probes/als-isolation.cjs` as a permanent matrix gate, so
the CJS detection branch — invisible to the ESM suite — is proved on every
supported version.

**Remaining risk.** Runtimes without `AsyncLocalStorage` at all (browsers,
DOM-less edge) still share one store across interleaved async requests. That is
inherent, now documented in the support matrix, and now warned about.

---

## Framework declaration bugs surfaced by type-checking the tests

Detailed in [`test-type-errors.md`](test-type-errors.md); summarised here because
they are framework fixes, not test fixes.

- **TYPE-001** (34 test errors) — `eventBus` and the `normalize` family rejected
  a generic argument declared as an `interface`, because interfaces have no
  implicit index signature. Idiomatic usage failed to compile while the runtime
  handled it perfectly. Constraints widened to `T extends object`.
- **TYPE-003** (8) — `RouterLink` always builds an `<a>` but was declared
  `HTMLElement`, so reading back the props it sets did not type-check. Now
  returns `HTMLAnchorElement`.
- **TYPE-007** (3) — `globalStore`'s action constraint required every action to
  *accept* `payload?: unknown`, making typed payloads unassignable and
  collapsing `Parameters<A[K]>[1]` — which `dispatch` already relied on — to
  `unknown`. Replaced with an exported `StoreActionMap<S>`.

Four further declaration gaps (TYPE-002, TYPE-006, TYPE-009, TYPE-010) were
confirmed and deliberately left open: each needs a public API change, which does
not belong in a preflight pass. Their call sites carry documented casts.

---

## Test-suite finding

- **TYPE-008** — `tests/disposal.test.ts` read `store.count` (the imported
  *factory function*) instead of `s.count` (the store instance). The effect
  subscribed to **nothing**, so the subsequent "subscriber dead" assertion held
  trivially — the subscriber was never alive. Caught only because the suite is
  now type-checked.

Thirteen further tests used `cb?.(0)` to invoke a callback captured from a
mocked global. That pattern compiles but silently no-ops when the mock never
fired, so those tests could have gone vacuous without anyone noticing. They now
use `callbackSlot()` from `tests/helpers/mocks.ts`, whose `invoke()` throws if
nothing was captured. All still pass, so the mocks were genuinely firing.

---

---

## CI-001 — no committed lockfile, so `npm ci` is unavailable

```text
Severity:   P3
Affected:   CI reproducibility
Status:     Open (repository-policy decision)
```

`.gitignore` lists `package-lock.json`, and the file is untracked. A fresh
checkout therefore has no lockfile, which means:

- `npm ci` fails outright — it exists precisely to install *from* a lockfile;
- `actions/setup-node`'s `cache: npm` fails too, since it derives its cache key
  from one.

Found by actually performing the clean-checkout verification: the first version
of the new CI workflow used `npm ci` and `cache: npm`, and would have failed on
its first run. Both were reverted to `npm install --no-audit --no-fund`, which
is what the previous workflow already did.

The consequence is that CI resolves dependency versions afresh on every run, so
a transitive release can change what CI tested without any commit to this repo.
Committing the lockfile would fix that and let `npm ci` and the setup-node cache
come back — but that is a repository-policy choice with its own trade-offs, so it
is recommended rather than applied.

---

## CI shape after this pass

```text
fast  (every PR and push to main)
├── npm install
├── npm run build          # first: the unit suite reads dist/ (TEST-007)
├── npm run typecheck      # source
├── npm run typecheck:tests
├── npm run lint
└── vitest run

node-matrix  (every PR and push, fail-fast: false)
├── Node 22 ─┐
└── Node 24 ─┴── install · build · both typechecks · unit suite
                 · node-matrix.mjs (packed tarball, 13 gates)
```

Both typechecks are new gates: CI previously ran none at all, which is how 130
test type errors and five framework declaration bugs accumulated unseen.

`node-matrix` is pinned to the versions in `engines.node`. Widening that range
without adding the version here would re-create exactly the gap this pass closed,
so the workflow says so in a comment next to the matrix list.

### Verified from a clean checkout

The whole fast lane was re-run in a fresh tree with no `node_modules`, no
`dist/`, and no lockfile:

| Step | Result |
|---|---|
| `npm install` | PASS |
| `npm run typecheck:tests` **before any build** | PASS — 0 errors |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run lint` | PASS |
| `vitest run` | PASS — 4 383 tests, 362 files |

`typecheck:tests` was deliberately run *first*, before `dist/` existed, to prove
it type-checks against source declarations rather than passing on a stale build
artefact (§40).

---

## What changed in `src/`

| File | Change | Finding |
|---|---|---|
| `src/plugins/router.ts` | `updateHistory` guards the `history` global | NODE-001 |
| `src/plugins/router.ts` | `RouterLink` returns `HTMLAnchorElement` | TYPE-003 |
| `src/core/ssr-context.ts` | Lexical `require` branch; one-time ALS diagnostic | NODE-002 |
| `src/ui/eventBus.ts` | `T extends object` | TYPE-001 |
| `src/performance/normalize.ts` | `T extends object` + localised internal casts | TYPE-001 |
| `src/patterns/globalStore.ts` | Exported `StoreActionMap<S>` constraint | TYPE-007 |

No behaviour changed for any input that previously worked. The two runtime fixes
both convert a thrown error or a silent degradation into correct operation.
