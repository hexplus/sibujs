# Router Hardening Findings

Every finding was reproduced with a failing test **before** any production code
changed. Items investigated and found already correct are listed at the end, and
no code was changed for them.

Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

---

## R-001 — A superseded navigation could commit router state

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `SibuRouter.performNavigation` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

The router already created an `AbortController` per navigation and aborted the
previous one on each new navigation. **Nothing checked that signal at the commit
boundary.** A navigation that was superseded mid-flight would resume after its
`await` and commit anyway — rewriting history, overwriting the newer route,
firing `afterEach`, and applying its scroll position.

This violated the router's most important rule: *only the currently active
navigation may commit.*

Two distinct holes fed it:

1. `runBeforeEach` / `runBeforeResolve` test `signal.aborted` only **inside**
   their loop. With no guards registered the loop body never executes, so an
   already-aborted navigation sails straight through.
2. A route's `beforeEnter` is awaited **directly** (`await guard(to, from)`),
   unlike the global guards which go through `GuardManager.runGuard` and reject
   on abort. Nothing re-checked the signal after that await.

### Reproduction

```ts
setRoutes([
  { path: "/slow", component: Slow, beforeEnter: () => gate.promise },
  { path: "/fast", component: Fast },
]);

const slow = navigate("/slow");   // parks inside beforeEnter
await navigate("/fast");          // supersedes and commits
gate.resolve(true);               // stale guard finally allows
await slow;

// Expected: /fast
// Actual:   /slow — location, route(), afterEach and scroll all rewritten
```

All six cases in the regression suite failed before the fix: route state,
history entry, `afterEach` hooks, scroll behaviour, three-way latest-wins, and
commit-after-`destroyRouter()`.

### Root cause

Cancellation was *signalled* but never *enforced*. The abort plumbing existed
end-to-end; the pipeline simply never asked "am I still the active navigation?"
before mutating shared state.

### Fix

Smallest robust change — one check at the commit boundary, where every path
converges immediately before shared state is touched:

```ts
if (signal.aborted) {
  throw new NavigationFailureError("aborted", from, to);
}
// ...history, currentRoute, afterEach, scroll
```

Placed there rather than after each individual `await`, because the commit block
is the only place that mutates shared state, and redirect recursion re-enters it
on every hop.

Two defence-in-depth checks were added so a stale navigation stops doing wasted
work rather than merely failing at the end: a post-await abort check in the
`beforeEnter` loop, and a pre-loop check in both global guard runners so an
empty guard list cannot skip the test.

A superseded navigation now resolves as `{ success: false, type: "aborted" }`,
matching how a guard-blocked navigation already reported.

### Regression test

`tests/router-hardening-race.test.ts` — 6 cases: route state, history entry,
`afterEach`, scroll, three overlapping navigations, and destroy-during-pending.

### Remaining risk

Low. Now additionally verified in Chromium, Firefox, and WebKit: real
back/forward traversal, history-entry counts, and route/location agreement are
covered by `tests-browser/router.spec.ts`.

---

## R-002 — `destroyRouter()` during a pending navigation

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `SibuRouter.destroy` |
| **Status** | Fixed (by R-001) |
| **Class** | CONFIRMED BUG |

`destroy()` already aborted the navigator, but because the commit path ignored
the signal, a navigation in flight at teardown still committed afterwards —
mutating `history` and route state for a router that no longer existed.

The R-001 commit-boundary check closes this with no separate change. Covered by
"a destroyed router must not commit a pending navigation" and "a navigation
started before destroy cannot mutate history afterwards".

---

## R-003 — Redirect loops had no diagnostic

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `SibuRouter.performNavigation` |
| **Status** | Fixed |
| **Class** | DOCUMENTATION / DX |

Redirect recursion was correctly **bounded** by `MAX_REDIRECT_DEPTH = 10`, so
this was never a hang or stack overflow. But it failed with a bare `aborted`
navigation failure and no explanation, leaving the developer to work out which
routes formed the cycle.

**Fix:** thread the hop sequence through the recursion and, in development only,
print it:

```text
[SibuJS] Router: redirect loop detected — navigation aborted after 10 hops.
  "/login" -> "/dashboard" -> "/login" -> ...
```

Production behaviour is unchanged; the diagnostic is behind `isDev()`.

Covered by "names the offending hop sequence when a loop is detected".

---

## R-004 — `RouterLink` ignored `event.defaultPrevented`

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `RouterLink` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG (found by real-browser testing) |

### Description

`RouterLink`'s click handler correctly declined to intercept modifier clicks,
non-primary buttons, and `target`-bearing links — but never checked
`event.defaultPrevented`. Application code that cancelled a click (a confirm
dialog, a disabled state, an outer handler) still had the router navigate out
from under it.

Native semantics are unambiguous: once the default action is prevented, no
default action should occur. The router was performing one anyway.

### Reproducer

```ts
const link = RouterLink({ to: "/users", nodes: "Users" });
link.addEventListener("click", (e) => e.preventDefault(), true); // capture phase

link.click();
// Expected: no navigation
// Actual:   route() === "/users"
```

Found by the Chromium run of `tests-browser/router.spec.ts` — the fixture's
prevented link navigated anyway. **This is the one defect the browser matrix
surfaced that jsdom-only testing had missed**, because no prior test registered
a competing capture-phase handler.

### Root cause

The guard clause enumerated *why the browser would handle the click natively*
(modifier, button, target) but omitted *whether anyone had already cancelled
it*.

### Fix

One condition, first in the chain:

```ts
if (e.defaultPrevented || target || e.metaKey || ... ) return;
```

### Regression test

`tests-browser/router.spec.ts` — "respects an app handler that called
preventDefault" (all three engines), plus jsdom coverage in
`tests/router-hardening-result-semantics.test.ts` with a positive control
("still navigates for an ordinary click") so the fix cannot regress into
never navigating.

### Remaining risk

Low.

---

## R-005 — Navigation failures were semantically ambiguous

| | |
|---|---|
| **Severity** | P1 (API) |
| **Subsystem** | `NavigationResult` / `NavigationFailure` |
| **Status** | Fixed |
| **Class** | DESIGN DEFECT |

### Description

Both a guard-blocked navigation and a superseded one returned:

```ts
{ success: false, type: "aborted" }
```

A caller could not distinguish "you are not allowed in here" (show a message)
from "you clicked a newer link" (stay silent) from "the router was destroyed"
(stay silent). In practice this forces applications either to show spurious
errors during rapid navigation, or to suppress genuine authorization failures.

### Fix — additive, non-breaking

Added an optional `reason` discriminator to both `NavigationFailure` and the
failure branch of `NavigationResult`. Existing `type` values are unchanged, so
code branching on `type` keeps working:

```ts
type NavigationFailureReason =
  | "guard"            // a guard returned false
  | "superseded"       // a newer navigation started first
  | "router-destroyed" // teardown cancelled it
  | "redirect-loop"    // exceeded the redirect hop limit
  | "unsafe-target"    // blocked scheme / open-redirect
  | "duplicate"        // identical to the current route
  | "error";           // unexpected fault
```

Supersession and teardown are distinguished by stamping the abort reason onto
the `AbortSignal` — `controller.abort(reason)` — and reading `signal.reason` at
the commit boundary. Teardown additionally sets a `destroyed` flag, because it
clears the controller and no signal survives to carry the reason on paths that
reject with a plain `Error`.

### Regression test

`tests/router-hardening-result-semantics.test.ts` — 10 cases covering every
reason, an explicit side-by-side proof that guard-blocked and superseded share
a `type` but differ in `reason`, and a compatibility test pinning the legacy
`type` field.

### Remaining risk

`reason` is optional, so a failure constructed by an untouched code path would
report `undefined`. All in-tree throw sites are tagged.

---

## R-006 — Plain `<a href>` is never intercepted (documented behaviour, not a bug)

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | link handling |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

SibuJS installs **no global document-level click handler**. Interception is
per-element and only applies to anchors created by `RouterLink()`. A plain
`<a href="/users">` performs a real browser navigation and leaves the SPA.

This differs from routers that intercept every same-origin anchor, and it
surprised this audit — the first browser fixture was written assuming global
interception and every link test failed with a full page load. It is a
legitimate design (explicit over implicit, no global side effects, consistent
with `sideEffects: false`), but it must be documented, because migrating users
will otherwise write plain anchors and get full page reloads.

Pinned by "a plain `<a href>` is NOT intercepted (documented behaviour)" in the
browser suite.

---

## R-007 — WebKit handles modifier and middle clicks differently

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | browser behaviour |
| **Status** | Documented; tests corrected |
| **Class** | BROWSER DIFFERENCE (not a router defect) |

Two link-interception tests failed on WebKit only while passing on Chromium and
Firefox. Investigation (instrumenting the actual `MouseEvent` the router
receives) showed:

- **Chromium** fires no `click` at all for a middle click — it dispatches
  `auxclick` — and opens a new tab for modifier clicks.
- **WebKit** performs a **real same-tab navigation** for both, destroying the
  SPA's module scope.

In both cases the router behaved correctly: it never intercepted. The failing
assertion was mine — it asserted `location.pathname` was unchanged, which
encodes a browser-behaviour assumption rather than a router guarantee.

Tests now assert the actual invariant: *if the SPA is still alive, its route
must be unchanged*. If the document genuinely navigated, the browser handled the
click, which is the desired non-interception outcome.

Worth recording as a caution: a naive "the URL did not change" assertion is not
a portable way to test non-interception.

---

## Investigated and found correct

Tested, confirmed working, **not changed**. The tests are kept as regression
protection — several of these are exactly the areas the hardening plan flagged
as high-risk, and they held up.

| Area | Result |
|---|---|
| **Lazy route supersession (DOM)** | Correct. `Route()` holds a monotonic `navSeq`; a lazy chunk resolving after supersession is dropped and never mounts. Verified at the DOM level, with a positive control proving the lazy path is genuinely exercised. |
| **Redirect bounding** | Correct. Two-route cycles, self-redirects, and three-route cycles all terminate as failures; legitimate multi-hop chains still complete. |
| **Route component disposal** | Exactly once per replacement. Verified across A→B, A→B→A, and 100 alternating navigations. |
| **Outlet DOM accumulation** | None. Exactly one rendered route remains after 100 replacements. |
| **Binding-count growth** | Flat. `checkLeaks()` does not grow across 100 navigations. |
| **Disposal on teardown** | The mounted route component is disposed when the router is destroyed. |
| **Listener hygiene** | No accumulation. Across 50 create/destroy cycles, every listener type is removed at least as often as added. |
| **`push` vs `replace`** | `push` adds exactly one history entry; `replace` adds none. |
| **popstate** | Does not create a new history entry; route state and `location` stay in agreement. |
| **Route matching precedence** | `/users/new` beats `/users/:id`; stable sort preserves registration order at equal specificity. |
| **Same-route navigation** | Reported as `duplicated`, pipeline not re-run. Query-only and hash-only changes are real navigations. |
| **Param decoding** | `%20` decodes correctly; a malformed sequence does not crash the router. |
| **Open-redirect protection** | Absolute and protocol-relative redirect targets refused; dangerous URI schemes refused throughout. |
| **500 sequential navigations** | Stable final state, no drift between `route()` and `location`. |
