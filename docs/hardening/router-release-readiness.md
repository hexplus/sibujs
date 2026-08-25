# Router Release Readiness

Covers two hardening passes. Pass 1 established the navigation transaction model
and closed the stale-commit races. Pass 2 (this document's update) added
navigation-result semantics, the real-browser matrix, link-interception
coverage, seeded model testing, and memory regression tests.

## Classification

**PRODUCTION-READY.**

Upgraded from *production-capable with caveats*. Every criterion the hardening
plan sets for this tier is now met:

| Criterion | Status |
|---|---|
| Real-browser tests pass in Chromium, Firefox, WebKit | **Met** — 60/60, 20 tests × 3 engines |
| History / back-forward semantics verified | **Met** — real traversal, entry counts, rapid back/forward |
| Link interception verified | **Met** — 9 cases incl. modifier, middle, `_blank`, nested, prevented, plain anchor |
| No known P1 navigation/lifecycle bugs | **Met** — R-001, R-002, R-005 fixed; none open |
| Router memory tests bounded | **Met** — flat across 1 000 replacements, 200 create/destroy cycles, 200 lazy cancellations |
| SSR/hydration tested if claimed supported | **Partial** — see limitations |

It is **not** *production-hardened*. That tier is explicitly reserved for
substantially broader real-world and long-duration evidence, which a test suite
cannot supply.

## Metrics

| Metric | Pass 1 baseline | After pass 1 | After pass 2 |
|---|---|---|---|
| Router test files (jsdom) | 18 | 21 | 23 |
| Router tests (jsdom) | 263 | 295 | 324 |
| Router browser tests | 0 | 0 | **60** (20 × 3 engines) |
| Full suite | 4 076 | 4 114 | 4 143 passing (1 GC-gated skip) |
| Known P1 router bugs | 2 (undiscovered) | 0 | 0 |
| `tsc --noEmit` / `biome` | clean | clean | clean |

61 net new router tests in pass 2. Public API is additive-only.

## Findings this pass

| ID | Severity | Class | Summary |
|---|---|---|---|
| R-004 | P2 | Confirmed bug | `RouterLink` ignored `event.defaultPrevented` — app code that cancelled a click still navigated |
| R-005 | P1 (API) | Design defect | Guard rejection and supersession were indistinguishable to callers |
| R-006 | — | Design characteristic | Plain `<a href>` is never intercepted; only `RouterLink` is |
| R-007 | — | Browser difference | WebKit same-tab-navigates on modifier/middle click where Chromium fires `auxclick` |

**R-004 is the defect the browser matrix earned its keep on.** No jsdom test had
registered a competing capture-phase handler, so the missing
`defaultPrevented` check survived the entire first pass.

## Navigation result API change

Additive, non-breaking. `type` values are unchanged; an optional `reason`
discriminator was added to `NavigationFailure` and to the failure branch of
`NavigationResult`:

```ts
type NavigationFailureReason =
  | "guard"            // a guard returned false
  | "superseded"       // a newer navigation started first
  | "router-destroyed" // teardown cancelled it
  | "redirect-loop"    // exceeded the redirect hop limit
  | "unsafe-target"    // blocked scheme / open-redirect refusal
  | "duplicate"        // identical to the current route
  | "error";           // unexpected fault
```

Callers can now distinguish an authorization failure worth surfacing from the
routine supersession of rapid navigation:

```ts
const result = await navigate("/admin");
if (!result.success && result.reason === "guard") {
  showMessage("You do not have access to that page.");
}
// "superseded" and "router-destroyed" are expected — stay silent.
```

Supersession and teardown are separated by stamping the abort reason onto the
`AbortSignal` and reading `signal.reason` at the commit boundary.

## Browser results

`tests-browser/router.spec.ts`, run against Chromium, Firefox, and WebKit.
**60 passed, 0 failed.**

| Area | Cases | Result |
|---|---|---|
| History integration | 7 | pass on all engines |
| Link interception | 9 | pass on all engines |
| Hash and params | 3 | pass on all engines |
| Focus behaviour | 2 | pass on all engines |

Covered: `pushState`, `replaceState`, real back, real forward, rapid
back/forward, history-entry counts, route/location agreement, primary-button
interception, nested-element clicks, modifier clicks, shift-click, middle-click,
`target="_blank"`, `preventDefault`, plain anchors, hash navigation, dynamic and
encoded params, and focus preservation across navigation and traversal.

**Engine difference found (R-007):** WebKit performs a real same-tab navigation
for modifier and middle clicks; Chromium fires `auxclick` and opens a new tab.
Neither is a router defect — the router declined to intercept in both cases. The
lesson recorded in the findings is that "the URL did not change" is not a
portable assertion for non-interception; the portable one is "if the SPA is
still alive, its route is unchanged".

## Stress and model results

Seeded reference-model testing (`tests/router-hardening-model.test.ts`):

- **450 operations** across 3 seeds (123456, 987654, 42), comparing router state
  against an external model after every step. Operations: navigate, replace,
  guard-denied, and redirect targets. Both `route().path` and
  `location.pathname` are checked each step; a divergence reports the seed and
  the full operation sequence for replay.
- **100 unawaited concurrent navigations** settle on exactly the last target.

No divergence found.

## Memory results

All measured with `checkLeaks()` (live DOM binding count), which returns to
baseline rather than growing:

| Scenario | Result |
|---|---|
| 1 000 route replacements through a live `Route()` outlet | flat (≤ baseline + 2) |
| 200 create → navigate → destroy router cycles | flat (≤ baseline + 2) |
| 200 abandoned lazy-route navigations | flat (≤ baseline + 4) |
| 1 000 hook register/unregister cycles | no hook fires after unregistration |
| 50 create/destroy cycles, listener accounting | every listener type removed ≥ as often as added |

## Focus behaviour (documented, unchanged)

The router **delegates focus entirely to the application**. It does not move,
reset, or restore focus on navigation. Verified in all three engines: a focused
input stays focused across a client-side navigation, and the router neither
blurs nor refocuses anything during back/forward traversal.

No automatic focus management was added — the plan explicitly forbids inventing
it, and doing so would be a behavioural break for existing apps. Applications
needing route-change focus management (an accessibility requirement for many)
must implement it in an `afterEach` hook.

## Monolith decision — deliberately deferred

`src/plugins/router.ts` is ~2 460 lines. The plan asks whether a file-boundary
split materially improves test isolation, ownership clarity, merge-conflict
risk, cognitive load, and dependency direction. Assessment:

| Criterion | Verdict |
|---|---|
| Test isolation | **No gain.** Every behaviour proved testable through the public API — 324 jsdom + 60 browser tests, including internals like the commit boundary and abort reasons, with no seams needed. |
| Ownership clarity | **Marginal.** Responsibilities are already separated into `NavigationController`, `RouteMatcher`, `GuardManager`, `ComponentLoader`, `SibuRouter`. The boundaries exist; only the file does not. |
| Merge-conflict risk | **Real but modest gain.** |
| Cognitive load | **Marginal.** Both real fixes this pass were 1–3 lines in a single well-named method, located in minutes. |
| Dependency direction | **No gain.** No cycles or inverted dependencies were found. |

**Decision: defer.** The refactor would touch every line of the highest-risk
subsystem in the framework to buy mostly cosmetic benefit, immediately after
two passes of correctness work whose regression suite is the only thing standing
behind it. The plan's own guidance — *"Do NOT mechanically split a file merely
because it is large"* — points the same way.

Revisit when there is a functional reason: a second router implementation, a
tree-shaking requirement to split navigation from components, or sustained
multi-contributor conflict on the file.

## Known limitations

- **SSR and hydration router behaviour is untested by this pass.**
  `routerSSR.ts` (650 lines) has its own passing suite, but no server-match /
  hydration-mismatch coverage was added, and no audit confirmed it avoids
  `window`/`document`/`history`/`location` without guards. **This is the largest
  remaining gap.**
- **Large route tables unmeasured.** 100/1 000/5 000-route registration and match
  cost were not benchmarked. Matcher complexity is documented analytically in
  [router.md](../architecture/router.md) but not empirically confirmed.
- **Singleton router.** A module-level ref holds the active instance; multiple
  concurrent routers are unsupported and untested.
- **Nested routes and deep Outlet nesting** rely on pre-existing coverage; no
  adversarial nesting tests were added.
- **`performNavigation` does not await component loading.** Navigation commits
  first and the outlet resolves the component afterwards. Correct given
  `navSeq`, but "navigation succeeded" does not imply "UI is mounted".
- **Redirect-loop detection is depth-based, not cycle-detecting.** A legitimate
  chain longer than 10 hops fails identically to a true cycle.
- **Plain anchors are not intercepted** (R-006). Migrating users must use
  `RouterLink` or wire their own delegation.

## Recommendation

**Ship as production-ready**, with the SSR/hydration gap stated plainly in
release notes rather than glossed.

Remaining work, in priority order:

1. SSR/hydration router audit and test matrix — the one gap that blocks a
   complete claim for the router's full advertised surface.
2. Large route-table performance measurement.
3. Adversarial nested-route and Outlet-nesting coverage.
4. Revisit the monolith split when a functional trigger appears.
