# Async Ownership

Every asynchronous operation in SibuJS has an owner. When the work finishes, the
question that decides correctness is not *did it succeed* but **is the thing
that started it still entitled to commit the result?**

This document collects the invariants that answer that, and where each is
enforced.

## The seven questions

For any async subsystem:

```text
WHO owns the operation?
WHO may cancel it?
WHO may commit its result?
WHO may still observe it?
WHAT happens when one observer disappears?
WHAT happens when the owner changes?
WHAT happens when the final observer disappears?
```

The recurring anti-pattern is a **split between the work and its cancellation**:
a shared resource whose abort handle belongs to a single consumer. When that
consumer walks away, it takes everyone else's work with it.

## Invariants

### Shared-request invariant

> A shared async operation may not be cancelled solely because one observer
> loses interest while another observer still owns the result.

Enforced in `query()`: the **cache entry** owns the in-flight promise *and* its
`AbortController`. Query instances are observers. Disposing one, or changing its
key, never aborts work another still needs.

### Generation invariant

> Same key, URL, or value does not imply same async generation.

`A → B → A` returns to an identical identifier under a *newer* generation.
Equality of the identifier must never restore commit permission.

Enforced by monotonic counters:

| Subsystem | Counter | Advanced by |
|---|---|---|
| client router | `navEpoch` | every committed navigation, and `destroy()` |
| `hydrateRouter` bootstrap | captures `navEpoch` | — re-checked at the commit |
| `query()` | `entry.generation` | every new request on that entry, **and abandonment** |
| `infiniteQuery()` | `runId` | every new run |
| `Route()` outlet | `navSeq` | every render pass |

### Observer-attachment invariant

> A live observer must be attached to the **current concrete cache entry** for
> its key — reattaching when the entry object is replaced, even though the key
> is unchanged.

```text
same key  ≠  same CacheEntry
```

`clearQueryCache()` replaces entries without changing keys, so any registration
driven by key comparison never re-runs and silently detaches observers.
Attachment is therefore keyed on entry identity, and is idempotent: attaching
twice to the same entry must not inflate the subscriber count.

### Cache-commit vs local-commit

> A result may update the shared cache even when the instance that requested it
> no longer cares — but it may only update *that instance's* local state if the
> instance still cares.

These are different permissions and must be checked separately. Conflating them
strands other observers with no data when the initiator moves on.

```text
request settles
      │
      ├─► cache commit    — gated on GENERATION
      │
      └─► local commit    — gated on generation AND this observer's liveness
```

### Disposal invariant

> Disposed consumers may not receive local state commits.

### Terminal-state invariant

> Once an owner reaches a disposed, reset, or superseded state, stale async work
> can never regain ownership.

Superseded once is superseded permanently. This is why generations are
monotonic rather than a comparison against a captured value that can recur.

### Cache invariant

> A cleared or evicted cache entry may not be resurrected by a stale async
> completion.

`clearQueryCache()` aborts every in-flight request it discards, and garbage
collection aborts a request whose entry has no observers left.

### Abandonment policy

> A request is cancelled when its **entry** is abandoned — never when an
> individual observer leaves.

Abandoning an entry **advances its generation**. This matters more than it
looks: a request already in flight holds a reference to the entry *object*, so
removing that object from the cache map changes nothing it can observe. Without
advancing the generation, an abandoned request still looks like the owner and
can commit, or report settlement, after the entry it belonged to is gone.

Advancing the generation is also what keeps the rule single-sourced — cache
commit, local commit, and `onSettled` all consult the same counter, so there is
no second "is this abandoned?" flag to keep in sync.

Concretely, `query()` aborts on:

- `clearQueryCache()`;
- garbage collection of an entry whose subscriber count reached zero.

It does **not** abort on: instance disposal, key change, or component unmount
while other observers remain.

### SSR isolation invariant

> Request-specific data must remain isolated across concurrent SSR contexts.

Backed by `AsyncLocalStorage` (`runInSSRContext`). The query cache is
request-scoped under SSR.

**Exception, documented rather than fixed:** `context()` is application-global
and lives outside this isolation. See [context.md](./context.md).

### Terminal-state cleanup

> Every terminal path — success, error, abort, cancellation — must leave the
> observer in a settled state.

An abort is not an application error, but it must still clear the fetching
flags it raised. Returning early on abort without clearing them was a real bug
in both `query()` and `infiniteQuery()`.

## Recognising an abort

`DOMException` is not available in every runtime a fetcher may execute in, and
userland fetchers commonly reject with a plain `{ name: "AbortError" }`. Abort
detection therefore tests the `name` property rather than the constructor.

## Where each subsystem stands

| Subsystem | Owner | Cancels when | Generation guard |
|---|---|---|---|
| router navigation | the navigation transaction | superseded, or router destroyed | `navEpoch` |
| `hydrateRouter` bootstrap | the bootstrap | — | captured `navEpoch` |
| `query()` fetch | the **cache entry** | entry cleared or GC'd | `entry.generation` |
| `infiniteQuery()` page | the run | superseded run | `runId` |
| `mutation()` | the call | superseded call | run id |
| SSR Suspense boundary | the boundary | stream abandoned | per-request id |
| island activation | the mount scope | `cleanup()` | `activated` + `torndown` |
| hydration | the container | container disposed | — |
