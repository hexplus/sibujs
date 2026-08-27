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
| `Route()` outlet | `navSeq` | every render pass, **and outlet disposal** |
| `Outlet()` (nested) | `navSeq` | every update pass, **and outlet disposal** |
| `KeepAliveRoute()` outlet | `updateSeq` | every update pass, **and outlet disposal** |
| router `Suspense()` boundary | `generation` | every render pass, **and boundary disposal** |

For the KeepAlive outlet the distinction the invariant names is unusually easy
to get wrong, because the outlet holds a second identifier that *looks* like an
ownership token but is not one:

```text
cache key         answers:  "Which cached view is this?"
update generation answers:  "May this async completion still commit?"
```

Pathname, query, hash, and cache-key equality are all route **values**. None of
them grants commit permission. `/search?q=a` and `/search?q=b` share a pathname;
an A → B → A round trip returns to an identical cache key under a newer
generation. See [router.md](./router.md#the-keepalive-outlet).

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

### User-code reentrancy invariant

> Ownership must be revalidated after executing arbitrary user code, even when
> no `await` occurs.

An `await` is not the only way ownership moves. Synchronous user code can
navigate, dispose its own owner, unmount a subtree, or otherwise invalidate the
current generation — and it runs *between* the check and the commit:

```text
OWNERSHIP CHECK
      ↓
ARBITRARY USER CODE      ← component(), fallback(), a hook, a callback
      ↓
OWNERSHIP CHECK AGAIN
      ↓
COMMIT
```

Every arbitrary user-code boundary between validation and commit requires a
second validation. Two corollaries:

- **Re-read the parent.** A `parentNode` captured before user code ran is not
  evidence the outlet is still mounted after it returns.
- **`parentNode` is not a liveness test.** A subtree detached from the document
  still has internal parent links, so a node orphaned without disposal looks
  "attached" from the inside. Liveness is a `torn`/generation flag set by
  disposal, never a DOM query.

Where the check runs before user code as well as after, stale work never invokes
user code at all — the strongest form, because a component factory may have side
effects of its own.

### Load-vs-instantiate invariant

> Resolving *how* to build something is not building it.

A loader may fetch a module, resolve a factory, and cache both. It must never
invoke user code merely to inspect what that code returns: a speculative call
runs side effects the framework cannot undo, and its result is either leaked or
disposed — and if the result happens to be the very instance that will later be
mounted, disposing it corrupts the mount.

```text
LOAD DEFINITION
      ↓
no user component execution
      ↓
a generation needs an instance
      ↓
INVOKE ONCE  →  Element | Promise<Element>
      ↓
ownership check
      ↓
COMMIT or DISPOSE
```

Two shapes to avoid:

```text
invoke for validation → discard/dispose → invoke again for real
AsyncComponent resolves E → cache `() => E` → dispose E → mount E again
```

Classification must never require duplicate user-code execution: detect a
thenable on the *real* invocation instead of calling once to decide and again to
use.

The same boundary governs **preloading**:

```text
PRELOAD
   ↓
module/factory resolution only
   ↓
NO COMPONENT INVOCATION
   ↓
NO DOM
   ↓
NO LIFECYCLE RESOURCES
```

`preload ≠ instantiate`. Preloading may run module-loading machinery; it may not
run application component code. Where a component form has nothing separately
loadable — a directly supplied factory, however async — preloading is a no-op
rather than a speculative call. See
[router.md § Preloading](./router.md#preloading).

And the rule that makes that enforceable rather than aspirational:

> Preloadability is explicit metadata or branding. It is never inferred by
> executing application code, and never by parsing it.

Both inference routes fail, for the same underlying reason — neither runtime
behaviour nor source representation is a declaration of intent:

| Inference | Why it fails |
|---|---|
| call it and inspect the result | that *is* instantiation; the side effects have already happened |
| `constructor.name === "AsyncFunction"` | an async component is indistinguishable from an async module loader |
| `toString()` contains `import(` | ordinary components mention it in strings and comments; bundlers rewrite real ones away |

A brand set at registration is metadata: it survives compilation, bundling and
minification, because it is part of what the value *is* rather than how it was
written.

### Stale-result disposal

> Discarding a stale async result is not the same as dropping it.

An async run that loses ownership usually resolves with something already
**built** — a DOM node with live effects, listeners and registered disposers,
created before the run discovered it had been superseded. Letting the reference
go leaves those resources running against a node nobody will ever see.

```text
run loses ownership
        ↓
result already constructed?
        ├── yes → dispose(result), then discard
        └── no  → discard
```

The router `Suspense()` boundary is the clearest instance: its promise resolves
with a fully constructed `Element`. See
[router.md](./router.md#suspense-boundaries).

### Disposal invariant

> Disposed consumers may not receive local state commits.

A disposed **owner of DOM** carries an extra obligation. If the losing generation
has already created a node, returning early is not enough — the node has
registered effects and listeners that nothing will ever tear down. The rule is:

```text
generation G starts
      ↓
   await
      ↓
is G still current?  is the owner still alive?
      ↓ NO
dispose everything G created, then stop
```

Enforced in `KeepAliveRoute()`: the ownership check runs once before the node is
created (so a superseded generation never builds one) and again immediately
before the commit (so a node built by user code that then navigated, or tore the
outlet down, is `dispose()`d rather than leaked).

### Observer-isolation invariant

> Shared observer notification must isolate observers from each other's
> exceptions, and a user callback throwing is never an operation failure.

Two separate claims, both enforced in the data layer via
`src/data/callbacks.ts`:

**Isolation.** An unguarded `for (const listener of listeners) listener()`
aborts at the first throw. One observer with a broken `select` then starves
every observer registered after it, on a request that succeeded. Listener
iteration is therefore individually guarded, over a snapshot of the set.

**Classification.** The success or failure of an operation is decided by the
operation, never by a notification callback:

```text
network success ──► cache commit ──► user callback ──► callback throws
                                                            │
                          operation is STILL a success ◄─────┘
                          callback error surfaced separately
```

Running callbacks inside the request's own `try`/`catch` collapsed those two
channels: a throwing `onSuccess` was caught by the catch meant for the fetch,
stamped onto the shared cache entry as the request's error, and passed to
`onError`. Every observer of that key was told a successful request had failed.

The one deliberate exception is `mutation()`'s `onMutate`, which is a *step of*
the operation rather than a notification — it produces the rollback context the
mutation depends on, so its failure is a mutation failure.

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
| `Route()` outlet | the update pass | superseded, or anchor disposed | `navSeq` + `routeTorn` |
| `Outlet()` (nested) | the update pass | superseded, or outlet disposed | `navSeq` + `outletTorn` |
| `KeepAliveRoute()` outlet | the update pass | superseded, or outlet disposed | `updateSeq` + `kaTorn` |
| `hydrateRouter` bootstrap | the bootstrap | — | captured `navEpoch` |
| `query()` fetch | the **cache entry** | entry cleared or GC'd | `entry.generation` |
| `infiniteQuery()` page | the run | superseded run | `runId` |
| `mutation()` | the call | superseded call | run id |
| SSR Suspense boundary | the boundary | stream abandoned | per-request id |
| router `Suspense()` boundary | the boundary | boundary disposed, or anchor detached | `generation` + `tornDown` |
| island activation | the mount scope | `cleanup()` | `activated` + `torndown` |
| hydration | the container | container disposed | — |
| `defineRemoteComponent()` load | the rendered container | container disposed | `disposed` flag on the container's disposer |
| `infiniteScroll()` page load | the controller | `dispose()` | `disposed` + `generation` |
| `clipboard().copy()` | the controller | `dispose()` | `disposed` |
| `permissions()` query | the controller | `dispose()` | `disposed`, on **both** settle paths |
| `serviceWorker()` registration | the wrapper | `unregister()` succeeded | `unregistered` + `unregisterRequested` |
| `offlineStore().sync()` | the transaction | `close()` | adapter snapshotted for the whole sync |
| keyed `loadWasmModule()` | the cache key | — | shared in-flight promise per key |

### Load-vs-instantiate, restated for remote components

`defineRemoteComponent()` makes the distinction in
[Load-vs-instantiate invariant](#load-vs-instantiate-invariant) concrete:

- **Caching the resolved module after disposal is correct.** The module is
  shared, immutable, and expensive to fetch; the next instance renders instantly.
- **Instantiating the component after disposal is not.** It builds DOM and
  registers effects and disposers inside a container nobody will dispose again.

So the loader's `.then` caches unconditionally and *then* checks liveness before
calling the factory. The rejection path checks liveness too — a disposed
container must not receive an error fallback either.

### Settling state at disposal, not after it

Where a pending completion is the only thing that would have cleared a flag,
`dispose()` clears it itself rather than leaving the work to a completion that is
no longer permitted to write. `infiniteScroll().dispose()` sets `loading` to
`false` for this reason: guarding the completion without settling the flag would
leave `loading()` permanently `true` for anything still reading the controller.

### Containing a floating promise

An `IntersectionObserver` callback cannot `await`. `infiniteScroll` therefore
makes `loadMore()` **contain its own failure** — it reports through
`reportError` (phase `"async"`) and never rejects to its caller — and the
observer discards the promise explicitly with `void`. A floating rejection is an
unhandled rejection, which crashes a Node SSR process and fires
`window.onunhandledrejection` in a browser, for what is only a failed page of
data. Containment is not silence: the failure still reaches the one place
applications install telemetry.
