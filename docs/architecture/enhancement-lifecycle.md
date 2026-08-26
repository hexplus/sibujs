# Enhancement lifecycle

How `enhance()`, `enhanceAll()` and the island runtime own, commit and release
framework resources.

The companion documents are [dom-ownership.md](./dom-ownership.md) (who owns a
node) and [async-ownership.md](./async-ownership.md) (who may commit when async
work lands). This one answers a narrower question: **when does an enhancement
own anything, and what happens when setup fails?**

---

## The governing invariant

> **Setup is a transaction over framework-owned resources.**

| Phase | Guarantee |
|---|---|
| setup success | lifecycle ownership commits |
| setup failure | every framework resource accumulated before the throw rolls back |
| dispose | active ownership ends |
| retry / remount | starts from a clean lifecycle state |

---

## State machine

```
                        UNENHANCED
                            │
                    enhance(root, setup)
                            │
                            ▼
                       SETTING_UP           ← ctx.on / text / attr / model /
                            │                 classed / show / cleanup
                            │                 accumulate teardowns
              ┌─────────────┴─────────────┐
       setup throws                 setup returns
              │                            │
              ▼                            ▼
          ROLLBACK                      COMMIT
   drain teardowns (each                register disposer
   at most once, failures               record ownership token
   isolated), rethrow the               set data-sibu-enhanced
   original error                            │
              │                              ▼
              ▼                            ACTIVE
          UNENHANCED                         │
        (retry is legal)                  dispose()
                                             │
                                             ▼
                                          DISPOSED
                                   release marker (if still
                                   owner), drop node entry,
                                   drain teardowns
                                             │
                                             ▼
                                        UNENHANCED
                                    (remount is legal)
```

### Forbidden states

These are what the tests exist to prevent:

| Forbidden | Prevented by |
|---|---|
| FAILED + LIVE BINDINGS | the `try/catch` around `setup(ctx)` drains every accumulated teardown |
| DISPOSED + ACTIVE LISTENERS | teardowns are spliced off the list before running, so each runs exactly once and none is skipped |
| UNENHANCED MARKER + ACTIVE OWNER | the marker is written on commit, in the same step that registers the disposer |
| ACTIVE MARKER + NO ACTIVE OWNER | disposal removes the marker — this was the ENH-002 bug |

---

## Marker contract — `data-sibu-enhanced`

**The marker means: this element currently owns an active enhancement.** It is
lifecycle state, not history.

| Event | Marker |
|---|---|
| successful `enhance()` | added |
| `dispose()` from the returned disposer | removed |
| `dispose(root)` from the DOM disposal walk | removed |
| setup threw | never added |
| `enhance()` on an already-active root | refused, dev-warns, marker untouched |

Two consumers read it, both asking the same ownership question: the `enhance()`
idempotency guard, and the `mountIslands()` "already mounted, skip" check.

### Ordering

The marker is written **after** setup completes and after the disposer is
registered, so it is never observable for an enhancement that did not commit.

On disposal the order inverts: the marker is released **before** teardowns run,
so a teardown that legitimately re-enhances the root does not trip over a stale
marker.

### Generation safety

Ownership is tracked by a module-level `WeakMap<HTMLElement, symbol>` holding
the current generation's token. A disposer releases the marker only while its
own token is still the current one.

This makes stale disposers harmless:

```ts
const d1 = enhance(root, setup);
d1();                              // gen 1 releases the marker
const d2 = enhance(root, setup);   // gen 2 claims it
d1();                              // stale replay — must NOT strip gen 2
```

Blind `removeAttribute()` would break that sequence. The refusal path is covered
by the same principle: `enhance()` on an active root returns an **inert**
disposer that owns nothing, so calling it cannot release the live enhancement.

### `data-sibu-hydrated` is a different kind of marker

It is hydration **provenance**, not ownership. `ssr.ts` writes it with three
values (`"true"` / `"partial"` / `"progressive"`) describing how a container was
hydrated, and excludes it from hydration mismatch diagnostics. Nothing reads it
as an activation gate, so it is not part of this state machine and is not
removed on disposal. A failed island is never stamped hydrated, because the
attribute is written only after `enhance()` returns.

---

## The rollback boundary

Rollback covers **framework-owned resources** — everything registered through
the `EnhanceContext`:

| Covered | Not covered |
|---|---|
| `ctx.on()` listeners | `root.innerHTML = …` and other direct DOM writes |
| `ctx.text()` / `ctx.attr()` / `ctx.classed()` / `ctx.show()` effects | mutation of application objects |
| `ctx.model()` (both directions, plus its listener) | network requests already in flight |
| `ctx.cleanup()` callbacks | global side effects, timers created directly |
| a cleanup returned from setup | anything not routed through `ctx` |

SibuJS cannot generically reverse the right-hand column, and does not pretend
to. A setup that must undo its own non-framework work should register that
undo with `ctx.cleanup()` **as it goes** — registered cleanups run during
rollback, in the same drain as the bindings.

---

## Rollback mechanics

Both the failure path and the disposal path drain through one routine, so there
is a single teardown model rather than two incompatible ones.

- **At most once per teardown.** Entries are spliced off the list *before* they
  execute, so re-entry cannot re-run them.
- **Failure isolation.** A throwing teardown is reported via `console.error` —
  the convention `dispose()` already uses — and the remaining teardowns still
  run. No new public error API was introduced for this.
- **Reentrancy.** `ctx.cleanup()` stays reachable from inside a teardown, so the
  queue can grow while it is being drained. It is drained **until it is stable
  or the safety ceiling is reached** — see the policy below.
- **The original error wins.** `enhance()` rethrows exactly what setup threw, by
  identity. A rollback failure never masks it, and neither does a runaway.
  `enhance()` never converts a failed setup into a success — isolating and
  reporting is the caller's job, and `mountIslands()` does exactly that.

### Reentrancy policy

> **Bounded runaway protection is not permission to abandon registered cleanup.**

A cleanup registering another cleanup is legitimate — a parent teardown
releasing a child, a hook re-arming — and that follow-up work is owed the same
guarantee as the first batch. So:

- **Finite cleanup chains of ordinary practical depth drain completely.**
  Draining continues until the queue stabilises **or** the total-work safety
  ceiling is reached — cleanup is never dropped merely for crossing an internal
  boundary.
- **Non-terminating or excessively large cleanup production is bounded by the
  total-work safety ceiling** (`MAX_DRAIN_TEARDOWNS`, 10 000 teardown
  executions) — not by a limit on iterations over the queue. A total-work cap
  distinguishes ordinary reentrant chains from typical runaway behaviour far
  better than a pass cap, while still imposing an **absolute upper bound**: it
  is a work ceiling, not a recursion detector, so a finite chain needing more
  than 10 000 executions reaches it just as an infinite producer does. Finite
  chains are therefore not guaranteed to complete regardless of length — only
  ones of realistic depth.
- **Reaching the ceiling is reported, never silent.** `console.error` names how
  many teardowns ran and how many were still queued. A caller is never told
  cleanup completed when queued work was dropped.
- **Normal cost is unchanged.** Batch-splicing keeps the ordinary path
  O(number of teardowns); there is no per-entry `shift()`, and no recursion —
  the drain is iterative, so deep chains cannot overflow the stack.

### Where the two queues differ

`enhance()` and `dispose()` share the policy but not the consequences, because
their queues have different reachability:

| | `enhance()` teardowns | `dispose()` node disposers |
|---|---|---|
| Storage | array local to one enhancement | `WeakMap` keyed by node |
| Reachable after the drain returns? | **No** — unreachable forever | **Yes** — a later `dispose(node)` drains it, and `checkLeaks()` still counts it |
| On runaway | queue cleared, runaway reported | untouched remainder **restored to the map**, runaway reported |

So an enhancement's abandoned work is genuinely lost and must be reported
loudly; a node's is deferred and still observable. Restoring rather than
clearing is the stronger option wherever it is available.

### Disposal reaching the root during setup

`ctx.root` is public, so a setup can call `dispose(ctx.root)` — and a parent
teardown can reach the same node. The in-flight enhancement is not registered
yet, so the disposal walk cannot reach it: it tears down whatever *previously*
owned the node, and the new enhancement then commits normally.

This is deliberate and pinned by test. The committed generation is the live one,
with no stale marker and no surviving binding from the generation it replaced.
It is not a forbidden state — the enhancement is the newer operation, and it
completed.

The island runtime is different, because there the *owner* (the mount) can go
away mid-setup while the enhancement still succeeds. That case is handled
explicitly — see [Two teardown races, one flag](#two-teardown-races-one-flag).

### Never speculative

Rollback never re-invokes user code to inspect or classify it. Setup runs once,
and only once — the same principle the router hardening established.

---

## `enhanceAll()` — a transaction across the collection

The collection is one transaction. If any element's setup throws, the
already-committed enhancements are unwound in **reverse creation order** and the
original error is rethrown:

```
A commits → B commits → C throws
                          │
              C rolls itself back inside enhance()
                          │
                    dispose B, dispose A
                          │
                   rethrow C's error
```

A caller that never received the aggregate disposer therefore never holds live
enhancements it cannot release. The returned disposer is idempotent, and the
collection is remountable afterwards.

---

## Islands

`mountIslands()` sits on top and adds *scheduling* plus *error isolation*. It
introduces no second lifecycle model — each island is one `enhance()`
transaction.

- **Failure isolation is real.** Because `enhance()` is transactional, a broken
  island leaves zero live bindings and zero live listeners; siblings mount
  normally.
- **Remount is supported.** Cleanup disposes each island and releases its
  marker, so the same server markup can be mounted again — across `load`,
  `idle`, `visible`, `interaction` and `media`.
- **Double mount while active is still refused.** A second `mountIslands()`
  without cleanup skips elements that currently own an enhancement.

### Two teardown races, one flag

`mountIslands()` keeps a `torndown` flag, checked at every point where an
activation could commit after its owner is gone:

| Race | Guard |
|---|---|
| cleanup lands **before** a lazy chunk resolves | re-check `torndown` after `resolveSetup()`; never enhance |
| cleanup lands **during** `setup()` | re-check `torndown` after `enhance()` returns; dispose immediately instead of pushing onto an already-drained list |

The second was ISL-002. Both express the same rule: **DISPOSED must never become
ACTIVE.**
