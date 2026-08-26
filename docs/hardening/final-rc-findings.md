# Final RC hardening — findings

Findings from the final narrowly-scoped hardening pass on `4.0.0-rc.1`.
Baseline: [`final-rc-hardening-baseline.md`](final-rc-hardening-baseline.md).

Every runtime finding below followed the required workflow — **failing
reproducer first**, then classification, then the smallest fix, then a
regression test. No runtime change in this document was made on the strength of
source review alone. Documentation corrections did not require failing tests.

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| KA-001 | KeepAlive async generation race | **P1** | Fixed |
| KA-002 | KeepAlive teardown resurrection / stale-node leak | **P1** | Fixed |
| DATA-001 | Observer exception isolation | **P2** | Fixed |
| DATA-002 | Lifecycle callback exception semantics | **P2** | Fixed |
| MEM-001 | DOM-less `scrollBehavior` escape | **P2** | Fixed |
| DOC-001 | `renderToReadableStream()` environment wording | P3 | Updated |
| DOC-002 | Hydration terminology | P3 | Verified — already correct |
| DOC-003 | Streaming terminology | P3 | Updated |

Severity is assigned on impact, not on the fact that this is RC work. KA-001 and
KA-002 are P1 because they silently corrupt what the user sees and leak
framework-owned resources with no error surfaced anywhere.

---

## KA-001 — KeepAlive async generation race

**Severity:** P1
**Status:** Fixed
**Component:** `src/plugins/router.ts` → `KeepAliveRoute()`

### Reproducer

`tests/router-hardening-keepalive.test.ts`:

- *"does not commit a lazy load superseded by a query-only navigation"*
- *"does not commit a lazy load superseded by a hash-only navigation"*
- *"does not let a stale A generation replace the A that superseded it"*

```text
KeepAliveRoute starts loading /search?q=a   (lazy chunk pending)
navigate /search?q=b                        (becomes current)
old /search?q=a chunk resolves
        ↓
BEFORE: the stale generation builds its node, inserts it into the DOM,
        and caches it — two instances attach where one should
```

Measured before the fix: the attachment log recorded **two** committed
instances (`search-2`, `search-3`) where exactly one is correct.

### Root cause

`KeepAliveRoute()` had not been migrated to the ownership model `Route()`
already used. It carried two separate defects that reinforced each other.

**1. Ownership inferred from a route value.** After awaiting the component, the
only staleness check was:

```ts
if (!node || route.path !== _routerRef.current!.currentRoute.path) { … }
```

`route.path` is the pathname with query and hash stripped. `/search?q=a` and
`/search?q=b` therefore compare **equal**, and the superseded generation was
granted commit permission. The outlet's own cache key is built from the full
location (path + query + hash), so cache identity and commit permission were
derived from two different, inconsistent notions of "same route".

The general form of the error:

```text
same route value  !=  same navigation generation
```

An A → B → A round trip returns to an identical pathname, query, hash, *and*
cache key under a newer generation. No route value can answer "may this
completion still commit?".

**2. Serialization masquerading as ownership.** `isUpdating` / `pendingUpdate`
made a second update defer instead of supersede:

```ts
if (isUpdating) { pendingUpdate = true; return; }
```

An in-flight lazy load thus held the outlet for its entire duration. In the
A → B → A test, navigation to `/b` never rendered at all — it was collapsed into
a boolean — and the *first* A generation committed at the end, after two further
navigations had already superseded it.

### Fix

Replaced the serialization with the same temporal-generation model `Route()`
uses (`navSeq` → `updateSeq`), and restructured the update so that ownership is
checked at every boundary that matters:

```text
claim generation
resolve cache key / decide cached vs fresh
await loadComponent
  ↓ ownership check  ← before creating anything
create node
  ↓ ownership check  ← at the commit boundary; dispose on failure
synchronous commit: detach outgoing, touch LRU, cache, insert
```

Notable consequences, both deliberate:

- The outgoing view now stays attached until a replacement is in hand. The old
  code detached it *before* awaiting, so a generation that never earned the
  right to commit could leave the outlet permanently empty.
- The commit section contains no `await`, so ownership cannot lapse midway
  through it.

### Regression test

`tests/router-hardening-keepalive.test.ts` — 9 tests, covering the required
matrix: simple lazy load, query supersession, hash supersession, A → B → A,
teardown during load, stale-node disposal, cached-instance reuse, `max`
eviction, and a deterministic multi-transition sequence.

### Remaining risk

Low. The model is now identical to `Route()`, which has been in place across
prior hardening passes. The behavior change noted above (previous view stays
visible during a lazy load) is observable but strictly an improvement for a
keep-alive outlet; no existing test depended on the blank interval.

---

## KA-002 — KeepAlive teardown resurrection and stale-node leak

**Severity:** P1
**Status:** Fixed
**Component:** `src/plugins/router.ts` → `KeepAliveRoute()`

### Reproducer

`tests/router-hardening-keepalive.test.ts`:

- *"does not resurrect a disposed outlet when its lazy load resolves"*
- *"does not repopulate the cache after the outlet is disposed"*
- *"disposes a created node when ownership is lost during creation"*

```text
KeepAlive lazy load starts
outlet is disposed  (kaCleanup runs: cache disposed and cleared)
lazy component resolves
        ↓
BEFORE: node created, inserted into the DOM, and written back into the
        cache that was just cleared — nothing can ever reach or dispose it
```

### Root cause

Two distinct leaks.

**Resurrection.** `update()` never consulted the teardown flag. `kaTorn` was
declared *after* `update()` and used only to make `kaCleanup` idempotent. The
async continuation therefore ran to completion on a dead outlet: `parent` had
been captured before the `await` and `kaCleanup` does not remove the anchor, so
`parent.insertBefore(...)` succeeded, and `cache.set(...)` repopulated a map
that had just been disposed and cleared.

**Stale-node leak.** The node was created *before* the staleness check:

```ts
const node = component();
if (!node || route.path !== …currentRoute.path) {
  isUpdating = false;
  return;            // ← live node, disposers registered, nothing will run them
}
```

`component()` is user code that registers effects, listeners, and disposers on
creation. Returning without `dispose(node)` leaked every one of them. This is
the concrete case behind the rule: *a lost generation must dispose what it
built, not merely decline to commit.*

### Fix

- `kaTorn` hoisted above `update()` and checked at both commit boundaries,
  alongside the generation.
- `kaCleanup()` now also advances `updateSeq`, so an in-flight generation is
  superseded by disposal itself rather than relying on the flag alone — the same
  belt-and-braces pattern `abandonEntry()` uses in `query()`.
- The first ownership check moved **before** `component()`, so a superseded
  generation never builds a node at all.
- The second check, immediately before the commit, calls `dispose(node)` on the
  node it is abandoning.
- `kaCleanup()` additionally disposes an *uncached* current view, which was
  previously detached but never torn down.

### Regression test

The three tests listed above, plus the multi-transition stress test, which
asserts that every instance built by a losing generation is disposed exactly
once and that only the cached views remain alive.

### Remaining risk

Low.

---

## DATA-001 — Observer exception isolation

**Severity:** P2
**Status:** Fixed
**Component:** `src/data/query.ts`, `src/data/callbacks.ts`

### Reproducer

`tests/data-callback-isolation.test.ts` → *"shared observer isolation"*:

```text
Observer A  select: () => { throw new Error("selector failed") }
Observer B  select: value => value
        \  /
   one shared successful request
        ↓
BEFORE: B.data() === undefined   — B was never notified
        B.error() === "selector failed"  — and was told the request failed
```

### Root cause

Cache notification iterated listeners unguarded:

```ts
for (const listener of entry.listeners) listener();
```

`onCacheUpdate` calls the observer's `select`. A throw aborts the entire loop,
so every observer registered *after* the broken one is starved — on a request
that succeeded.

Worse, that loop sits inside `doFetch`'s own `try`, whose `catch` treats
anything thrown as a request failure. Observer A's selector error was therefore
written to `entry.error` on the **shared** cache entry, and re-notified to every
observer. The second notification threw again, this time from inside the
`catch`, escaping `doFetch` entirely as an unhandled rejection.

The same unguarded loop appeared in `setQueryData()` and `clearQueryCache()`.

### Fix

Added `src/data/callbacks.ts` — an internal module, deliberately **not**
re-exported from `data.ts`, so no new public API. `notifyListeners()` guards
each listener individually and iterates a snapshot of the set (a listener may
attach or detach an observer while running). Applied at all five notification
sites.

`select` is additionally routed through `runSelect()`, which reports the failure
and signals that no value was produced, so the observer keeps the data it
already had instead of committing a value that never existed.

### Regression test

`tests/data-callback-isolation.test.ts` — 3 isolation tests plus the shared-key
cases in the query section.

### Remaining risk

Low. Reporting is via `console.error`; see the contract note below.

---

## DATA-002 — Lifecycle callback exception semantics

**Severity:** P2
**Status:** Fixed
**Component:** `src/data/query.ts`, `resource.ts`, `infiniteQuery.ts`, `mutation.ts`

### The contract decision

This was under-specified rather than merely broken, so the contract was decided
and documented before code changed.

> **A callback exception is not an operation failure.** The success or failure of
> an async operation is determined by the operation itself. Exceptions thrown by
> lifecycle callbacks do not retroactively change the success/failure state of
> the underlying request; they are surfaced independently.

```text
network success → cache commit → user callback → callback throws
                                                       │
                     operation remains a success ◄──────┘
                     callback error surfaced separately
```

**Reporting.** Via `console.error`, prefixed `[SibuJS data]`, unconditionally.
This follows the existing `safeCall()` convention in
`core/rendering/lifecycle.ts` — catch, report, keep going — rather than
inventing a new error API (which the scope explicitly excluded). `console.error`
rather than the dev-only `devWarn` because a silently swallowed data callback
error in production is precisely the failure mode being fixed.

**The one deliberate exception:** `mutation()`'s `onMutate` is *not* isolated. It
is a step *of* the operation — it produces the rollback context the mutation
depends on — not a notification. If it throws there is no context and the
optimistic update never happened, so treating that as a mutation failure is
correct. This is documented on the option itself.

### Reproducers and root cause

Every primitive ran its user callbacks inside the `try` that decides the
operation's outcome. Measured before the fix:

| Primitive | Scenario | Observed |
|---|---|---|
| `query()` | success + `onSuccess` throws | `error()` became the callback error; `onError` was invoked with it |
| `query()` | failure + `onError` throws | escaped `doFetch` → unhandled rejection; `onSettled` skipped |
| `query()` | `onSettled` throws | escaped from a `finally` → unhandled rejection |
| `resource()` | success + `onSuccess` throws | success overwritten with the callback error |
| `resource()` | `onStart` throws | fetch never started |
| `infiniteQuery()` | success + `onSuccess` throws | page appended, then error state set from the callback |
| `infiniteQuery()` | failure + `onError` throws | rejected both `promise` and its `void promise.finally(...)` |
| `mutation()` | success + `onSuccess` throws | status flipped `success` → `error`; `mutateAsync` rejected |
| `mutation()` | `onSettled` throws on success | same flip |
| `mutation()` | `onError` throws | replaced the mutation's own error; `onSettled` skipped |

The `mutation()` case is the sharpest: state had *already* been committed as
`success`, and the catch then re-committed it as `error` using the callback's
exception.

### Fix

All notification callbacks routed through `runCallback()`. Callback ordering is
now pinned and tested:

```text
success:  state commit → onSuccess → onSettled
failure:  state commit → onError   → onSettled
```

`onSettled` runs even when the callback before it threw.

### Regression test

`tests/data-callback-isolation.test.ts` — 26 tests covering the full required
matrix across all four primitives, including callback ordering, and a dedicated
unhandled-rejection gate that exercises every throwing-callback path through the
fire-and-forget entry points (effects, `mutate()`) where nothing awaits.

### Backward compatibility

Observable behavior change, classified as a **bug fix**. Code that relied on a
throwing `onSuccess` to force a query into an error state will no longer see
that. Since `4.0.0-rc.1` is a prerelease and the previous behavior was
unintentional — and produced unhandled rejections — this is a correctness
improvement rather than a breaking change. It is called out in the release notes
regardless.

### Remaining risk

Low. Optimistic rollback was deliberately not touched; a test pins that the
`onMutate → onError` context handoff still works when callbacks throw.

---

## MEM-001 — DOM-less `scrollBehavior` escape

**Severity:** P2
**Status:** Fixed
**Component:** `src/plugins/router.ts` → `Router.handleScrollBehavior()`

P2 rather than P3: the documented contract for DOM-less routers is that
browser-only side effects are skipped (NODE-001 established this for history),
and the failure is not a silent no-op — it reports a successful navigation as
failed.

### Reproducer

`tests/router-domless.test.ts` → *"a DOM-less router with scrollBehavior
navigates without reaching scroll APIs"* (runs under `@vitest-environment node`,
where `window` and `requestAnimationFrame` genuinely do not exist).

Measured before the fix: `result.success === false`.

### Root cause

```ts
requestAnimationFrame(() => { window.scrollTo(scrollTo.x, scrollTo.y); });
```

No environment probe, while the history write immediately above it *is* guarded
via `globalThis.history` (NODE-001). The guard coverage was asymmetric.

The consequence is worse than a missing scroll. `handleScrollBehavior()` runs at
the **end** of `navigateInternal()`, *after* `currentRouteSetter(to)` has already
committed the route. The `ReferenceError` therefore propagated out of the
navigation and was reported as `success: false` — while `router.currentRoute`
said the navigation had succeeded. Route state and the reported result
disagreed.

### First fix — Policy A (incomplete)

Consistent with NODE-001: the route still commits, and only the browser-only
side effect is skipped. Both primitives are probed, not just `window`, because
they can be missing independently (a partial DOM shim; jsdom without
`pretendToBeVisual`). `requestAnimationFrame` is invoked as a method on the
global object rather than through a detached reference, since browsers reject a
bare call with "Illegal invocation".

Note on reachability: `createMemoryRouter(routes, initialPath)` takes no options
object, so `scrollBehavior` cannot be passed to it directly. The reachable
configuration is `createRouter(routes, { scrollBehavior })` rendered
server-side — the same code path a memory router runs on every navigation.

### Why the first fix was incomplete

**It guarded the framework's own use of the browser primitives, but placed those
guards *after* the call to the user's callback.** The resulting order was:

```text
navigation commits
      ↓
scrollBehavior(to, from, null)     ← user code runs FIRST
      ↓
check requestAnimationFrame / window.scrollTo
      ↓
perform scroll
```

The guards protected the two lines SibuJS wrote and left the one line the
*application* wrote completely exposed. Two defects survived.

**Defect A — DOM-less callback execution.** A `scrollBehavior` implementation is
browser code by definition. An entirely ordinary one —

```ts
scrollBehavior: () => ({ x: 0, y: window.scrollY })
```

— throws `ReferenceError: window is not defined` on the server, *before* any
guard is reached. The first fix's own regression test even asserted the callback
still ran (`expect(calls.some(...)).toBe(true)`), having reasoned that running a
hook whose result is discarded is harmless. It is not: the hook is the thing
most likely to touch the missing globals.

**Defect B — a post-commit side effect revoking a committed navigation.**
`handleScrollBehavior()` runs after `currentRouteSetter(to)`, so an exception
from the callback propagated out of `navigateInternal()` and was reported as a
failed `NavigationResult` — producing the state the router must never be in:

```text
router.currentRoute.path === "/a"   and   location shows /a
                    but
await router.push("/a") → { success: false }
```

The reproducer showed this is worse in a DOM-less runtime than a browser one: the
bootstrap resolution also calls `handleScrollBehavior()`, so the callback threw
twice and the router never reached the target route at all.

A third, lower-severity gap: `window.scrollTo` was called inside the
`requestAnimationFrame` callback with no isolation. That runs outside the
navigation promise entirely, so a throw there has no catcher and surfaces as an
uncaught async error.

### Final fix

The environment guard now runs **before** the user callback, and each fallible
step is isolated at its own boundary:

```text
scrollBehavior configured?
        ↓ yes
primitives available?  → NO: return WITHOUT invoking the callback
        ↓ yes
invoke scrollBehavior, isolated   → throws? report, navigation stays successful
        ↓
position returned?     → falsy: return (unchanged contract)
        ↓
schedule scroll, isolated         → throws? report, no uncaught async error
```

Reporting uses `console.error` with the router's existing bracketed-prefix
convention (`[router] scrollBehavior failed:` / `[router] scroll failed:`),
matching the neighbouring `[router] redirect failed:`. No new public API, and no
generic `try`/`catch` around `performNavigation()` — isolation is applied only at
the two fallible post-commit side-effect boundaries, so genuine router defects
stay visible.

The callback arguments (`to`, `from`, `savedPosition`) and the falsy-return
contract are unchanged; this is not a scroll API redesign.

### Formalized semantics

> `scrollBehavior` is an optional, fallible, **post-commit browser side effect**.
> Navigation correctness is not scrolling correctness. Once the route has
> committed, a scroll callback failure is reported — never promoted into a
> navigation failure.

### Regression test

- `tests/router-domless.test.ts` — 9 tests under the `node` environment,
  including a premise guard asserting the primitives really are absent, a
  `vi.fn()` callback asserted **not** to have been called, a realistic
  `window.scrollY` callback, and an explicit result/state coherence assertion.
- `tests/router-scroll-behavior.test.ts` — 10 tests under jsdom: scrolling still
  works where the primitives exist, each primitive removed independently, a
  throwing callback that must leave the navigation successful and be reported, a
  redirect path, and a throwing `window.scrollTo` asserted to produce no
  unhandled rejection or uncaught exception.

One assertion from the first fix was **inverted** rather than added to:
`"a DOM-less router with scrollBehavior navigates without reaching scroll APIs"`
previously asserted the hook still ran. It now asserts the opposite. That earlier
assertion encoded the wrong contract and is the reason the gap shipped.

### Remaining risk

Low. The behaviour change is that a `scrollBehavior` hook no longer runs in
DOM-less runtimes. This is intentional and is now the documented contract; a hook
used for a non-scrolling side effect on the server would no longer fire, but such
a hook was already unreliable there — it could only work by never touching a
browser global.

---

## DOC-001 — `renderToReadableStream()` environment wording

**Severity:** P3 · **Status:** Updated

The docstring claimed:

> Compatible with Node 18+, Deno, and edge runtimes.

Wrong on two counts. SibuJS 4 declares `node >=22.3.0`, so "Node 18+" is below
the supported floor. And SSR rendering requires a DOM implementation — the
function takes real `Node` objects and walks them — so a DOM-less edge runtime
cannot supply the input regardless of its Web Streams support. Returning a Web
`ReadableStream` is not the same as running anywhere Web streams exist.

Replaced with the declared runtime plus the DOM requirement, and cross-referenced
to the architecture doc for streaming semantics.

## DOC-002 — Hydration terminology

**Severity:** P3 · **Status:** Verified — no change needed

Audited `docs/architecture/hydration.md`, `docs/support-matrix.md`,
`src/platform/ssr.ts`, and the README for wording implying node adoption,
listener attachment to existing server nodes, or identity-preserving hydration.
All already state replacement hydration correctly: server HTML provides initial
paint, the client live tree replaces the inert server subtree, DOM identity is
not preserved, and pre-hydration input may be lost. No stale wording found.

## DOC-003 — Streaming terminology

**Severity:** P3 · **Status:** Updated

`docs/architecture/ssr.md` described `renderToSuspenseStream()` as emitting

> the shell, then each resolved boundary followed by a small swap script

which reads as per-boundary progressive streaming. The implementation awaits
`Promise.all(pendingBoundaries)` — a single barrier — before emitting **any**
boundary. A boundary resolving in 5 ms is not sent until the one taking 3 s
completes. What streams early is the shell; the boundaries do not stream
relative to each other.

Corrected, with a diagram of the actual shell-then-batch shape.

The same section gained two clarifications that were previously unstated:

- **Suspense failure semantics.** `ssrSuspense` emits the fallback in all three
  non-success cases (pending, timeout, rejection), and **the emitted markup does
  not distinguish a permanently failed boundary from one still pending**. Both
  render as a fallback. Documented, not redesigned — no correctness defect was
  found here.
- **`query()` under SSR.** It *does* fetch during server rendering, into the
  request-scoped cache. What SSR does not do is block on those requests before
  serializing. Documented to match the implementation.

`docs/support-matrix.md` already said "not per-boundary progressive streaming"
and needed no change.

---

## Context semantics (§38) — verified, no change

`docs/architecture/context.md` already states plainly that `context()` is
application-global, is not subtree-scoped, is not SSR request-scoped, and that
`withContext()` scopes only the synchronous portion of its callback, with a
table pinning each. No stale wording found.

---

## Validation

Final state, measured against the baseline in
[`final-rc-hardening-baseline.md`](final-rc-hardening-baseline.md).

| Suite | Before | After | Δ |
|---|---:|---:|---:|
| Full unit/integration | 4391 (363 files) | **4445** (366 files) | +54 |
| Router subset | 338 (25 files) | **366** (27 files) | +28 |
| Data-layer subset | 195 | **221** | +26 |
| Soak | 16 | **18** | +2 |
| Browser (3 engines) | 150 | **156** | +6 |
| TypeScript — source | 0 errors | **0 errors** | — |
| TypeScript — tests | 0 errors | **0 errors** | — |
| Lint | clean | **clean** | — |

The delta is exactly the regression tests added: 9 KeepAlive + 9 DOM-less scroll
+ 10 DOM scroll + 26 data callback = 54. No previously passing test changed
state, and exactly one pre-existing assertion was deliberately inverted — see
"Why the first fix was incomplete" under MEM-001.

> **Correction to an earlier draft of this table.** The router subset was
> reported as `338 → 347`. That was a stale mid-pass measurement, taken before
> the two `scrollBehavior` test files existed; the correct post-pass figure is
> 366. The full-suite total was always measured at the end and was unaffected by
> the error.

`npm run certify:rc` — **ALL REQUIRED GATES PASSED**, 12 PASS / 0 FAIL /
1 NOT TESTED. The single unverified gate is the Node support matrix at exactly
`22.3.0` (that patch release is not installed on this host); Node 22 and Node 24
both PASS. This is pre-existing and unrelated to this pass.

### Two measurement artifacts worth recording

Both cost real time and would mislead anyone repeating this work.

**The loader's validation instance.** `ComponentLoader.doLoadComponent()` invokes
every newly loaded route factory once to assert it returns an Element, then
discards the result and memoises the factory — exactly once per route
definition. That throwaway node is never mounted and never disposed. Any leak
assertion that counts `registerDisposer` calls therefore carries a constant
`+1 per route definition` residual that has nothing to do with KeepAlive. It
first appeared as a fake KeepAlive soak failure (`expected 5 to be ≤ 3` with four
routes; `expected 8 to be ≤ 7` with three). It is not a leak — disposers live in
a `WeakMap` keyed by the node, so it is collected with the element — but it must
be excluded explicitly, or it masks and fakes real leaks in equal measure. Both
the unit tests and the soak now skip the first invocation, with the reason
stated inline.

**A self-inflicted concurrency failure.** An interim certification run reported
`FAIL — Full unit/integration suite`, and an interim browser matrix reported 7
Firefox failures in islands/hydration/lazy specs. Neither was real: the
certification runner's `Build` gate starts with `--clean`, and it was wiping
`dist/` while a separately-launched Playwright run was serving files out of it.
Both reproduced as green when run serially — Firefox passes 52/52 in isolation,
and the final serial certification passes every gate. Recorded because the
failure signature (unrelated specs failing on one engine) invites exactly the
wrong diagnosis.

## Architecture documentation updated

- [`../architecture/router.md`](../architecture/router.md) — new *"The KeepAlive
  outlet"* section (cache identity vs async ownership, commit rules, lifetime
  table) and *"DOM-less runtimes and the memory router"* section.
- [`../architecture/async-ownership.md`](../architecture/async-ownership.md) —
  `KeepAliveRoute()` added to the generation table and the subsystem table; new
  *observer-isolation invariant*; disposal invariant extended with the
  dispose-what-you-built rule.
- [`../architecture/ssr.md`](../architecture/ssr.md) — streaming shape, Suspense
  failure semantics, `query()` under SSR, environment requirements.
