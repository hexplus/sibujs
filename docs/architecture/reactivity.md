# Reactivity

## Problem

Update the DOM in response to state changes without re-running components and
without diffing a tree. The runtime must know, for any given signal write,
exactly which DOM targets depend on it.

## Design

SibuJS uses a push-based dependency graph with lazily-evaluated derivations.

```text
signal
   │  write bumps a version counter and notifies subscribers
   ▼
subscription graph        (doubly-linked lists, both directions)
   │
   ▼
reactive binding          (re-tracks its dependencies on every run)
   │
   ▼
one specific DOM target   (a text node, an attribute, a child range)
```

There is no component render step between the signal and the DOM. A binding
*is* the subscriber, and it writes to the node it closed over.

### Dependency tracking

`track(fn)` runs `fn` with a current-subscriber slot set. Every signal read
inside calls `recordDependency()`, which links signal ↔ subscriber. Links are
stored as intrusive doubly-linked lists on both sides, so subscribe and
unsubscribe are O(1) and need no array scans.

Dependencies are re-recorded on **every** run, not just the first. A branch that
only becomes live on a later run is subscribed then; a branch that goes dead is
unsubscribed. This is what makes conditional dependencies correct:

```ts
track(() => {
  cond() ? a() : b();   // exactly one of a/b is subscribed at any moment
});
```

### Derivations

`derived()` is **lazy and pull-based**: it caches a value and a version, and
recomputes only when read after an upstream change. A derivation that nobody
reads costs nothing to update.

### Scheduling

Writes notify synchronously by default. `batch(fn)` defers notification until
the outermost batch exits, so a burst of writes produces one flush. Batches
nest; only the outermost one flushes. If a batch body throws, the scheduler
state is restored before the exception propagates, so a thrown batch never
wedges the runtime into a permanently-batching state.

The notification drain is iterative and capped. A subscriber that keeps
re-invalidating itself trips a repeat guard rather than recursing without bound.

## Invariants

- **A disposed subscriber may never be resubscribed by a queued notification.**
  Disposal unlinks the subscriber from every signal and marks it dead; a
  notification already queued for it is skipped when the queue drains.
- **Disposal is idempotent.** Calling a teardown twice is safe.
- **Dependencies reflect the most recent run only.** No dependency recorded in
  an earlier run survives a run that did not re-read it.
- **A batch restores scheduler state on both normal and exceptional exit.**
- **One logical invalidation cycle must not cause uncontrolled recursive
  execution.** Cycle guards bound re-entrant updates.

Each of these has direct coverage in `tests/hardening-reactivity.test.ts`.

## Failure modes

| Symptom | Cause |
|---|---|
| Effect keeps firing after teardown | teardown handle never called — anchored primitives must register it (see [dom-ownership.md](./dom-ownership.md)) |
| Effect fires for a signal it no longer reads | would indicate stale links; covered by the dynamic-dependency tests |
| Runaway re-execution | an effect writing a signal it also reads; bounded by the cycle guard, which reports in development |
| Torn reads in a diamond | a derivation read mid-flush; derivations recompute on read, so the value observed is always internally consistent |

## Performance characteristics

| Operation | Cost |
|---|---|
| signal read (tracked) | O(1), with a back-pointer check to dedupe repeat reads in one run |
| signal read (untracked) | O(1) |
| signal write, no subscribers | O(1) |
| signal write, n subscribers | O(n) |
| derivation read, clean | O(1) |
| derivation read, dirty | O(cost of the body) |
| subscribe / unsubscribe | O(1) |

Signal state objects pre-declare every internal field at creation so the V8
hidden class stays stable and the hot paths remain monomorphic.

## Known limits

**Derived chain depth.** Because derivations are pull-based, reading the tail of
a chain of length N consumes N stack frames. Chains of ~1 000 links are
comfortably supported; the ceiling is roughly 2 000–3 000 and depends on the
host engine and the call context, at which point the JS stack — not SibuJS
bookkeeping — is the constraint. Real applications nest derivations tens deep,
not thousands, so this has not been traded against the performance of the common
case. The supported depth is pinned by a test; see
`tests/__depth_probe.test.ts`.

Note that **DOM disposal has no comparable limit**: `dispose()` walks the tree
iteratively with an explicit stack, so a deeply nested component tree tears down
without overflowing.

**Duplicate runtime copies.** The reactive core registers itself under
`Symbol.for("sibujs.reactive.v1")` so two physically distinct copies of the
package share one graph rather than silently failing to notify each other.
