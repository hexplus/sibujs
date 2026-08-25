# Async Ownership Findings — SSR Suspense, Query, InfiniteQuery, Context

Every finding was reproduced with a failing test before production code changed.

Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

## Baseline

| | |
|---|---|
| Full suite | 4 294 passing (1 GC-gated skip) |
| Data-layer tests | 140 |
| Browser tests | 129 |
| `tsc` / `biome` / build / Playwright | clean |

**Baseline note:** the first full run failed one test — `async-timing-characteristics.test.ts`,
added in the previous phase, asserted absolute macrotask timing and was flaky
under full-suite load. Fixed to assert ordering only, then confirmed stable
across three consecutive runs before any production change.

---

## ST-004 — SSR Suspense appended resolved content instead of replacing the fallback

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `suspenseSwapScript` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

The streamed swap script moved resolved nodes into the boundary wrapper without
first clearing it:

```js
while (t.firstChild) f.appendChild(t.firstChild);
```

`f` is the wrapper *containing the fallback*, so the loading UI remained on
screen above the real content:

```html
<div>Loading...  Resolved content</div>
```

### Reproducer

`tests-browser/ssr-suspense.spec.ts`, which injects the real streamed HTML into
a live document and lets the inline script execute — asserting on the stream
*string* would have proved nothing about the script's effect. Five of six cases
failed before the fix; the marker/payload removal already worked.

### Root cause

Append semantics where replace semantics were required.

### Fix

Clear the boundary before moving the resolved nodes in:

```js
while (f.firstChild) f.removeChild(f.firstChild);
while (t.firstChild) f.appendChild(t.firstChild);
```

Node moves rather than `innerHTML`, preserving the existing anti-DOM-XSS
property. No protocol change. `dispose()` is deliberately **not** called: this
patches inert server markup before hydration, and the framework may not even be
loaded when the script runs.

### Regression test

7 cases × 3 engines (21 total): simple swap, marker/payload removal, multi-node
resolved content, sibling boundaries, empty resolved content, idempotency, and
hostile content staying escaped and inert.

### Remaining risk

Low. Verified in Chromium, Firefox, and WebKit.

---

## QRY-001 — One subscriber could cancel a shared request another still needed

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `query()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

Ownership was split across abstraction levels:

```text
cache entry     owns the shared Promise
query instance  owns the AbortController
```

So a query instance changing key — or being disposed — called
`abortController.abort()` on a request other instances were deduplicated onto.
B lost its data because A navigated away.

### Reproducer

```ts
const a = query(keyA, fetcher);        // starts "profile"
const b = query(() => "profile", fetcher);  // deduplicates onto it

setKeyA("settings");                   // A loses interest
expect(profileSignal.aborted).toBe(false);  // FAILED: it was aborted
```

### Root cause

The in-flight operation and its cancellation handle lived at different ownership
levels.

### Fix — Strategy A, entry-owned request

`CacheEntry` now owns both the promise and the `AbortController`. Query
instances are pure observers.

Abort happens only when the **entry** is abandoned:

- `clearQueryCache()` — aborts every discarded entry;
- garbage collection of an entry whose subscriber count reached zero.

Never on instance disposal or key change.

### Regression test

`tests/query-hardening-ownership.test.ts` — key change with a live sibling,
disposal with a live sibling, disposed instance receiving no local commit, and
a 10-subscriber dedup count.

---

## QRY-002 — Deduplicated waiters could stay `fetching` forever

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `query()` dedup path |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

A waiter set `isFetching(true)`, captured the shared promise, then on resume
only refreshed if `entry.promise === captured`. But the owner nulls
`entry.promise` *before* waiters resume — so that check was false on every
normal completion, `onCacheUpdate()` never ran, and the flag never came down.

### Fix

Settle local state unconditionally in `finally` on every terminal path
(resolve, reject, abort). `onCacheUpdate()` is what clears the flag, so it must
always run.

### Regression test

Waiter state after shared resolve and after shared reject, plus after
`clearQueryCache()` and `invalidateQueries()` mid-flight.

---

## QRY-003 — Cache commit was gated on the initiator's local state

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `query()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG (found while fixing QRY-001) |

### Description

After the fetch settled, the owner returned early if it had been disposed or had
changed key — **before writing to the cache**. The shared result was therefore
never committed, and every other observer was stranded with `undefined`.

This only became visible once QRY-001 stopped aborting the request: the work
completed, and nobody recorded it.

### Fix

Split the two permissions, per the async-ownership model:

```text
cache commit  → gated on entry.generation only
local commit  → gated on generation AND this observer's liveness
```

Plus a monotonic `entry.generation`, so a result may only commit to the
generation that still owns the entry — key equality alone is not ownership.

### Regression test

A superseded generation resolving after a newer one for the same key, and a
companion test proving that revisiting a key *mid-flight* correctly
**deduplicates** rather than starting a second generation.

**Testing note:** my first ABA test premise was wrong. With a single instance,
`A → B → A` while A is still in flight deduplicates onto the original request —
correct behaviour, not a race. Two generations for one key coexist only when the
entry's promise is dropped (e.g. `clearQueryCache()`) while the old request is
still settling. The test was rewritten to that scenario.

---

## QRY-004 — An abandoned request could still report settlement

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `query()` / `clearQueryCache()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`clearQueryCache()` discards every entry and then refetches live subscribers.
A request owned by a discarded entry could still, on settling, fire `onSettled`
for an observer whose newer request was still in flight — telling the
application the work was done while it demonstrably was not.

The generation guard did not catch this on its own: a request in flight holds a
reference to the *entry object itself*, and clearing the cache removes that
object from the map without changing anything on it. Its captured generation
therefore still matched.

### Reproducer

```ts
const q = query(() => "K", fetcher, { onSettled });   // request 1 in flight
clearQueryCache();                                    // discards the entry,
                                                      // refetches -> request 2
onSettled.mockClear();
first.resolve("stale");                               // request 1 settles late

// Expected: no settlement reported — request 2 still in flight
// Actual:   onSettled fired
```

### Root cause

Two independent problems, both found during review rather than initial
implementation:

1. **The abandonment fix was applied to the wrong function.** `query.ts`
   contains two near-identical loops — one in `clearQueryCache()`, one in
   `__resetQueryCache()`. The original patch matched a pattern that landed in
   the internal test-reset helper, so the public API never abandoned anything.
   Most tests still passed, which is precisely what makes this shape of mistake
   dangerous.
2. **Removal from the map is not, by itself, supersession.** An in-flight
   request holds the entry object directly, so it needs a signal *on the object*
   to know it no longer owns anything.

### Fix

`abandonEntry()` now advances `entry.generation` in addition to aborting and
clearing. That single change makes every existing ownership check — cache
commit, local commit, and `onSettled` — treat abandoned work as superseded,
with no second discriminator to keep in sync. `onSettled` is additionally gated
on the owning generation.

### Regression test

`tests/query-cache-abandonment.test.ts` — deliberately a separate file, because
the behaviour spans two functions that look alike in source and a fix applied to
only one of them passes most other tests. Three cases: the owned request is
aborted, live subscribers are refetched rather than stranded, and an abandoned
request cannot report settlement afterwards.

### Remaining risk

Low.

---

## QRY-005 — `clearQueryCache()` silently detached live observers

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | query cache observer lifecycle |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`clearQueryCache()` replaces every `CacheEntry` and restarts live queries by
calling their stored refetchers. But `doFetch()` is fetch logic, not observer
registration — it registered a listener and refetcher **only on the path where
it had to create the entry**:

```ts
let entry = cache.get(key);
if (!entry) {                       // ← only here
  entry = getOrCreateEntry(cache, key);
  entry.listeners.add(onCacheUpdate);
  entry.refetchers.add(doFetch);
}
```

So with two observers on one key, the first refetcher recreated the entry and
registered itself; every other observer found the entry already present,
deduplicated onto the shared promise, and registered **nothing**.

The reconstructed entry ended up as:

```text
CacheEntry("profile") #2
  subscribers = 0      ← nobody incremented it
  listeners   = { A }
  refetchers  = { A }
```

with B still live but detached. Worse, `subscribers = 0` made the entry look
abandoned, so garbage collection could delete an entry that still had observers.

The compounding cause: normal registration lives in a reactive `effect` keyed on
`resolveKey()`, and subscriber counting was gated on `if (keyChanged)`. A cache
clear changes the **entry object** but not the **key string**, so the effect
never re-ran.

### Reproducer

The post-clear refetch is a poor probe — a detached observer still awaits the
shared promise directly and updates its own state, so it looks healthy. An
external cache write is the probe that exposes a missing listener:

```ts
const a = query(() => "K", fetcher);
const b = query(() => "K", fetcher);
await settle();

clearQueryCache();
await settle();
expect(a.data()).toBe(b.data());   // passes even when broken

setQueryData("K", "manual-update");
await settle();
expect(b.data()).toBe("manual-update");   // FAILED: b stayed at "v2"
```

Seven of ten new cases failed before the fix. The **single-observer** case
passed — the bug needs at least two.

### Root cause

Observer attachment was keyed on the **key string** rather than on the concrete
`CacheEntry` object.

```text
same key  ≠  same CacheEntry
```

### Fix

The query instance now tracks the concrete entry it is attached to
(`attachedEntry`), with two helpers:

- `attachToEntry(entry, key)` — idempotent. Returns immediately if already
  attached to that exact entry, so one observer can never inflate the
  subscriber count. Otherwise detaches from the previous entry, then increments
  `subscribers` and adds the listener and refetcher.
- `detachFromEntry()` — removes listener and refetcher, decrements
  `subscribers` with a `Math.max(0, …)` floor so a double-detach cannot make a
  live entry look abandoned, and schedules GC **only if the entry is still the
  live one for its key**. The timer re-checks entry identity before deleting, so
  a timer scheduled for a predecessor can never collect its replacement.

Both the registration effect and `doFetch()` now call `attachToEntry()` on every
entry acquisition, so a post-clear restart reattaches every observer regardless
of which one recreated the entry. `dispose()` reuses `detachFromEntry()`.

Registration responsibility stays with the observer; `clearQueryCache()` needs
no knowledge of observer internals. Entry-owned request ownership from QRY-001
is untouched — the entry still owns the promise, `AbortController`, and
generation.

### Regression test

`tests/query-observer-reattachment.test.ts` — 10 cases: 1, 2, and 10 observers
after a clear; `setQueryData` after clear; `invalidateQueries` after clear
(proving refetchers were restored, not just listeners); dedup preserved at one
restarted fetch; disposing one observer leaves the other attached; no GC of an
entry with a live observer under a short `cacheTime`; repeated clear cycles; no
double-attachment; and a clear-during-pending-restart race.

### Remaining risk

Low. Attachment is now expressed once, in two helpers, rather than duplicated
across the effect, `doFetch`, and `dispose`.

---

## INF-001 — Aborting the current run left `fetching` flags true forever

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `infiniteQuery()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

```ts
if (disposed || myRun !== runId) return;                       // correct
if (err instanceof DOMException && err.name === "AbortError") return;  // bug
```

The stale-run guard was right. The abort guard was not: when the **current** run
aborted, it returned before clearing the flags it had raised, so the query
reported `fetching: true` permanently with no request in flight.

### Fix

Distinguish the two cases explicitly — a stale run touches nothing; the current
run clears its own flags without setting an error (an abort is not an
application error).

Abort detection also now tests `err.name` rather than `instanceof DOMException`,
since that constructor is not available in every runtime and userland fetchers
commonly reject with a plain `{ name: "AbortError" }`.

### Regression test

`tests/infinitequery-hardening.test.ts` — 7 cases including a stale aborted run
that must *not* clear a newer run's flags.

---

## CTX-001 — `context()` is not isolated across concurrent SSR requests

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `context()` |
| **Status** | Documented + dev warning |
| **Class** | DESIGN CHARACTERISTIC |

`context()` is one module-level signal. It lives outside
`runInSSRContext()`'s `AsyncLocalStorage`, so under concurrent SSR one request
observes another's value.

**Policy chosen: A — application-global context**, documented prominently rather
than redesigned. The public API (`provide`/`use`/`get`/`set`/`withContext`) has
no provider component and no subtree boundary, so it never promised hierarchical
scoping. Making it request-scoped would change runtime behaviour for existing
users, and hierarchical context is a feature, not a hardening fix.

Development builds now warn when `provide()`, `set()`, or `withContext()` is
called during SSR, naming the hazard and pointing to the alternative.

Fully specified in [context.md](../architecture/context.md).

---

## CTX-002 — `withContext()` does not scope across `await`

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `context().withContext` |
| **Status** | Documented + dev warning |
| **Class** | DESIGN CHARACTERISTIC |

The value is restored in `finally`, which runs when an `async` callback
*returns its promise* — not when that promise settles. Everything after an
`await` runs outside the scope.

**Deliberately not "fixed" with a promise-aware restore.** Because the value is
global, restoring in `.finally()` would make the single-callback case read
correctly while leaving overlapping async scopes just as broken — making the
hazard harder to see rather than removing it. Real async scoping needs
continuation-local storage, which is a different feature.

Contract stated plainly: **synchronous-only**, with a development warning when
the callback returns a thenable.

---

## DOC-001 — `hydrate()` docstring described adoption, not replacement

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `hydrate()` |
| **Status** | Fixed |
| **Class** | DOCUMENTATION GAP |

The docstring said hydration works "by attaching event listeners and activating
reactive bindings" — implying DOM adoption. SibuJS replaces the server subtree.
Rewritten to describe replacement hydration, its consequences (no DOM identity,
pre-hydration input discarded), and its genuine upside (partial-adoption
mismatch bugs are structurally avoided), consistent with `hydration.md`.

---

## Investigated and found correct

| Area | Result |
|---|---|
| Query dedup | **PASS.** One underlying fetch for 2 and for 10 concurrent subscribers. |
| Query SSR isolation | **PASS.** Cache is request-scoped via `getActiveQueryCache()`. |
| `clearQueryCache` mid-flight | **PASS.** No stuck observer, no unhandled rejection; in-flight requests are now aborted. |
| `invalidateQueries` mid-flight | **PASS.** No stuck observer. |
| infiniteQuery stale-run guard | **PASS.** Pre-existing `runId` check was already correct. |
| infiniteQuery late resolve after dispose | **PASS.** No page appended. |
| Context sync nesting + exceptions | **PASS.** Unwinds in order, restores on throw. |
| SSR Suspense idempotency | **PASS.** Re-running the swap is a no-op. |
