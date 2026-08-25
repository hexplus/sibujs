# Hardening Findings

Every finding below was reproduced with a failing test **before** any production
code was changed. Findings that were suspected but not reproduced are recorded
as such, and no code was changed for them.

Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

---

## H-001 — `each()` leaks its entire row range on teardown

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `src/core/rendering/each.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`each()` returned a `Comment` anchor and registered only its `untrack` teardown
against it. Rows and the `each:end` sentinel are **siblings** of the anchor, not
children, so an ancestor `dispose()` walk never reached them.

This was both a visible rendering bug and a leak. When a conditional branch
swapped an `each()` away, every row stayed on screen underneath the replacement
content, and every row's bindings, listeners, and lifecycle hooks stayed live.

### Reproduction

```ts
const [visible, setVisible] = signal(true);
bindChildNode(placeholder, () =>
  visible() ? each(items, renderRow, { key: (i) => i.id }) : span("gone"),
);

setVisible(false);
// Expected: <span>gone</span>
// Actual:   <span>gone</span> plus all three orphaned rows, still reactive
```

### Root cause

Range ownership was not modelled. The anchor is the only handle an ancestor
walk can reach, so the anchor's disposer must own the whole logical range
`(anchor, end]` — but it only owned the subscription.

`KeepAlive()`, which uses the same anchored-sibling pattern, already did this
correctly. `each()` was the inconsistency.

### Fix

Replaced the bare `untrack` registration with a full range disposer that stops
the subscription, disposes and removes every owned row, removes the sentinel,
clears bookkeeping, and guards `update()` and the microtask retry against
running after disposal. Idempotent, and tolerant of rows an outside party
already detached.

### Regression test

`tests/hardening-disposal.test.ts` — 5 cases: sentinel removal, conditional
swap, row cleanup hooks firing exactly once, reactivity stopping after teardown,
and tolerance of pre-detached rows.

### Remaining risk

Low. `checkLeaks()` now returns to baseline across repeated `each()`
mount/destroy cycles (`tests/hardening-memory.test.ts`).

---

## H-002 — `Suspense` orphans its fallback on commit

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `src/core/rendering/lazy.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`Suspense` committed resolved content with `container.replaceChildren(el)`.
Native `replaceChildren()` detaches the outgoing fallback without running any
SibuJS teardown. Since the fallback is user-authored and routinely reactive, the
detached subtree kept re-rendering off-screen forever.

### Reproduction

```ts
const [progress, setProgress] = signal(0);
const fallbackEl = div(() => `${progress()}%`);

Suspense({ nodes: () => div("done"), fallback: () => fallbackEl });
// after resolution:
setProgress(10);
// Expected: fallbackEl.textContent stays "0%" (it is detached)
// Actual:   "10%" — the orphan is still subscribed and still updating
```

Fallback `onCleanup` hooks also never fired.

### Root cause

A native DOM removal API used on a subtree the framework owns. Same class of
defect as H-001, different mechanism.

### Fix

Added `replaceChildrenSafely(parent, ...next)` to
`src/core/rendering/dispose.ts`: it disposes outgoing children, skips any node
carried over into the new set, then performs the native replacement. Routed all
three `Suspense` commit paths and both `lazy()` replacement paths through it.
The incoming content is never disposed.

### Regression test

`tests/hardening-disposal.test.ts` — 4 cases: detached fallback stops updating,
fallback cleanup runs exactly once, incoming content is *not* disposed, and a
boundary torn down before resolution still disposes its fallback.

### Remaining risk

Low. Other `replaceChildren()` call sites were audited (see H-004).

---

## H-003 — `ErrorBoundary` commits async results into a disposed boundary

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `src/components/ErrorBoundary.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

For a promise-returning child, `ErrorBoundary` created an async container and
committed the result on settle — with no check that the boundary still existed.
If the boundary was torn down while the promise was in flight, the late result
built a fresh subtree (with its own bindings) inside a container already
detached from the document. Nothing would ever dispose it.

### Reproduction

```ts
const boundary = ErrorBoundary({ fallback }, () => pendingPromise);
dispose(boundary);
boundary.remove();

deferred.resolve(div({ id: "late" }, "late"));
// Expected: nothing is built
// Actual:   #late is constructed and attached to the dead container
```

### Root cause

Missing disposal guard on an async continuation — violating the invariant that
an async completion may not mutate a boundary that has already been disposed.

### Fix

Registered a disposer on the async container to record teardown. On resolve
after disposal, the already-constructed subtree is disposed rather than
attached (nothing else owns it). On reject after disposal, the rejection is
swallowed — it stays *handled*, so it never surfaces as an unhandled rejection,
but no error state is written to a boundary that no longer exists. Live
commits now go through `replaceChildrenSafely()`.

### Regression test

`tests/hardening-async-race.test.ts` — 6 cases including resolve-after-disposal,
reject-after-disposal, no unhandled rejection, abandoned `lazy()`, `Suspense`
disposed while pending, and out-of-order settlement.

### Remaining risk

Low for the boundary itself. Note the documented limitation that
`ErrorBoundary` observes only the promise *returned by* children — not
fire-and-forget rejections.

---

## H-004 — Native DOM removal audit

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | framework-wide |
| **Status** | Audited |
| **Class** | Audit result |

Every `remove()`, `removeChild()`, `replaceChild()`, `replaceChildren()`,
`innerHTML =`, `textContent =`, and `replaceWith()` in `src/` was reviewed
against the ownership model.

**Already correct — dispose before removal:**

- `DynamicComponent()` — disposes all children before each swap
- `Portal()` — disposes content, then removes it from the target
- `KeepAlive()` — disposes on eviction and disposes the whole cache on teardown
- `each()` phase-2 row removal — disposes removed rows
- `bindChildNode()` — disposes outgoing nodes not carried over
- `chunkLoader` — `clearChildren()` disposes each child before detaching

**Fixed in this pass:** `Suspense` / `lazy()` (H-002), `ErrorBoundary` (H-003).

**Not audited in depth:** `src/plugins/router.ts`, `src/platform/ssr.ts`,
`src/platform/microfrontend.ts`, `src/platform/customElement.ts`. These contain
removal call sites that were *not* proven correct or incorrect. See "Not
covered" in [release-readiness.md](./release-readiness.md).

---

## H-005 — Derived chain depth is stack-bounded

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `src/core/signals/derived.ts` |
| **Status** | Documented, not changed |
| **Class** | DESIGN RISK |

### Description

`derived()` is lazy and pull-based, so reading the tail of a chain of length N
consumes N stack frames. Chains beyond roughly 2 000–3 000 links throw
`RangeError: Maximum call stack size exceeded`. The exact ceiling varies with
the host engine and the call context.

### Why it was not "fixed"

Converting derivations to iterative evaluation would be a rewrite of a working,
performance-critical subsystem — an explicit non-goal of this effort. Real
applications nest derivations tens deep. The limitation is real, is now
documented, and the supported range is pinned by a test so a regression that
*narrows* it would be caught.

Note that `dispose()` has no comparable limit: it walks iteratively with an
explicit stack and tears down a 2 000-deep DOM tree without overflowing.

### Test

`tests/__depth_probe.test.ts`, and the depth cases in
`tests/hardening-reactivity.test.ts`.

---

## H-006 — README claimed "no reconciliation"

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `README.md` |
| **Status** | Fixed |
| **Class** | DOCUMENTATION ISSUE |

The README stated "no diffing, no reconciliation" nine lines above a feature
list describing "`each` — efficient keyed list rendering (LIS-based diffing)" —
an internal contradiction. Keyed `each()` legitimately performs localized
reconciliation over its own range.

Reworded to: *"No Virtual DOM and no component-tree reconciliation. Reactive
bindings update their exact DOM targets directly; keyed collections reconcile
only their own DOM range."*

---

## H-008 — `replaceChildrenSafely()` disposed incoming nodes nested in outgoing subtrees

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `src/core/rendering/dispose.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

The helper introduced by H-002 protected incoming nodes with a `Set` membership
test against `parent`'s **direct children** only. An incoming node that was
currently a *descendant* of an outgoing child was therefore not protected: its
ancestor was disposed, and the dispose-walk destroyed the incoming node on its
way down.

The node still ended up in the final DOM — but with its SibuJS lifecycle and
reactive resources already torn down. A silently dead node is worse than a
leaked one: it renders, and then simply stops responding.

### Reproduction

```ts
wrapper.appendChild(next);
parent.appendChild(wrapper);

replaceChildrenSafely(parent, next);

// Expected: next survives, wrapper is disposed
// Actual:   parent.firstChild === next, but next's disposers already ran
```

Three of six new cases failed before the fix, including the deeper
`parent > outer > inner > incoming` nesting.

### Root cause

Ownership was inferred from *position at the time of the call* rather than from
membership of the incoming set. Native `replaceChildren()` moves such a node out
and keeps it alive; the helper did not preserve that semantic.

### Fix

Detach every incoming node from its current parent **before** snapshotting
`parent.childNodes` and disposing the outgoing roots. Once detached, the
dispose-walk cannot reach them. Detaching before the snapshot also removes any
incoming node that was already a direct child from the outgoing set, so the
`keep` Set became unnecessary and was dropped — the fix is a net simplification.

Rejected alternative: skipping disposal of an outgoing child that contains an
incoming node. That would preserve the incoming node but leak the entire rest of
that subtree. Also rejected: adding an exclusion set to `dispose()`, which would
have meant redesigning the disposal core for one call site.

### Regression test

`tests/hardening-disposal.test.ts` — 6 cases: single-level nesting, three-level
nesting, removed siblings of a preserved nested node still disposed, a node
already a direct child, a node adopted from another tree (native move
semantics), and the empty-`next` clear-everything path.

### Remaining risk

Low. No in-tree caller currently passes a nested incoming node — `lazy()`,
`Suspense`, and `ErrorBoundary` all pass freshly created nodes — so this was
latent rather than live. It is now correct for the public API, where callers
can and will hit it.

---

## H-007 — `bench-baseline.json` is stale and unusable as a gate

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `bench.mjs` / `bench-baseline.json` |
| **Status** | Open |
| **Class** | CONFIRMED — tooling |

### Description

`npm run bench:check` reports **27 regressions against unmodified `main`**,
including `+324%` on "Create 10 000 `<div>` elements (no props)" — a benchmark
no recent change touches. The committed baseline was evidently recorded on
different hardware or a different Node version, so every comparison against it
is meaningless.

This matters more than a normal tooling nit: `bench:check` is exactly the gate
that would catch a real performance regression, and right now it cries wolf on
every run. A genuine regression would be invisible in the noise of 27 false
positives.

### Reproduction

```bash
git stash push -- src/    # unmodified tree
npm run bench:check       # → 27 regression(s) detected
```

### Recommended fix

Re-record the baseline on the machine/CI runner that will run the check
(`npm run bench:save`), and pin the Node version. Longer term, a baseline
committed to the repo is only meaningful if CI hardware is fixed; otherwise
compare against a same-session run of the merge base rather than a stored file.

### Impact on this pass

Performance was verified by direct same-session A/B comparison instead — see
[release-readiness.md](./release-readiness.md). No regression was attributable
to the changes here.

---

## Investigated and found correct

These were suspected, tested, and **not** changed — the tests are kept as
regression protection.

| Area | Result |
|---|---|
| Keyed reconciliation correctness | **No defects.** 31 cases including all structural mutations, node-identity preservation, string/numeric keys, 1–10 000 items, and 1 200 seeded random operations differentially compared against an external reference array. |
| Reactive dynamic dependencies | Correct. Obsolete branches unsubscribe; 2 000 branch flips leave ≤2 live subscriptions. |
| Diamond dependencies | No torn reads. |
| Disposal while queued | A subscriber disposed mid-batch never runs. |
| Batch semantics | Nested batches collapse to one flush; a throwing batch (nested or not) restores scheduler state. |
| Subscription hygiene | 1 000 create/dispose cycles return the subscriber count exactly to baseline. |
| Reentrant updates | Cycle guard terminates rather than hanging or overflowing. |
| `Portal` ownership | Correct and unambiguous — source owns content. |
| `KeepAlive` eviction | Disposes each evicted subtree exactly once; idempotent on repeat teardown. |
