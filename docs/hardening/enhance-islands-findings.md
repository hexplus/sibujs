# Enhancement / Island Lifecycle Findings

A narrowly-scoped ownership pass over the public progressive-enhancement
primitives: `enhance()`, `enhanceAll()` and the island runtime that drives them.

Every finding was reproduced with a failing test before production code changed.
Items investigated and found already correct are listed at the end.

Prefixes: **ENH** `enhance`/`enhanceAll` · **ISL** island runtime
Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

The governing invariant:

> **Setup is a transaction over framework-owned resources.**
> Setup success commits lifecycle ownership; setup failure rolls back every
> framework resource accumulated before the throw; disposal ends ownership; and
> a retry or remount starts from a clean lifecycle state.

---

## Baseline

Recorded before any production change, on `4.0.0-rc.1`:

| Gate | Result |
|---|---|
| Full suite | 371 files, 4602 passed, 1 skipped |
| `enhance` / islands / disposal / lifecycle subset | 8 files, 109 passed |
| `tsc --noEmit` (source) | 0 errors |
| `tsc -p tsconfig.test.json` (tests) | 0 errors |
| `biome check src/ tests/` | clean, 574 files |
| Soak (`npm run test:soak`) | 2 files, 21 passed, 1 skipped |

Behaviour at baseline:

- `enhance()` ran `setup(ctx)` **outside** any try/catch, immediately before
  registering the root disposer and stamping the marker.
- `data-sibu-enhanced="true"` was written on success and **never removed**, by
  any code path.
- `enhanceAll()` was `Array.from(...).map((el) => enhance(el, setup))`.
- `mountIslands()` caught island setup failures and reported them, gating
  activation on `data-sibu-enhanced`.
- `data-sibu-hydrated` was written on island activation and never removed;
  `ssr.ts` writes the same attribute with `"true"` / `"partial"` / `"progressive"`
  as hydration provenance.

---

## ENH-001 — a throwing `setup()` left its bindings, listeners and effects alive

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `enhance()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`enhance()` accumulated framework-owned teardowns in a local `teardowns` array
as the setup called `ctx.text()`, `ctx.attr()`, `ctx.on()`, `ctx.model()` and
`ctx.cleanup()`. That array only became reachable through the `dispose` closure
built *after* `setup(ctx)` returned.

When setup threw, the exception propagated straight out of `enhance()`. The
closure was never constructed, `registerDisposer()` was never called, and the
array became unreachable — while every effect it held was still subscribed and
every listener it held was still attached. The result was a permanent zombie:
live reactive bindings driving DOM on behalf of an enhancement that failed, with
no disposer in existence anywhere that could stop them.

### Reproducer

```ts
const [n, setN] = signal(1);
let listenerCalls = 0;

expect(() =>
  enhance(root, (ctx) => {
    ctx.text("@n", () => n());
    ctx.on("@b", "click", () => listenerCalls++);
    ctx.cleanup(() => cleanupCalls++);
    throw new Error("setup failed");
  }),
).toThrow("setup failed");

setN(2);
expect(textNode.textContent).toBe("1"); // FAILED at baseline: "2" — effect still live
button.click();
expect(listenerCalls).toBe(0);          // FAILED at baseline: 1 — listener still attached
expect(cleanupCalls).toBe(1);           // FAILED at baseline: 0 — never ran
```

### Root cause

`const extra = setup(ctx);` at the top level of the function body. There was no
transaction boundary: the teardown list had no owner until setup had already
succeeded.

### Fix

Wrap `setup(ctx)` in `try/catch`. On failure, drain the accumulated teardowns
through the same routine that disposal uses, then **rethrow the original error
unchanged**. `enhance()` does not convert a failure into a success, and does not
wrap or replace the error — higher layers such as `mountIslands()` remain free
to isolate and report it.

Draining is failure-isolating and reentrancy-safe: entries are spliced off the
list before they run (at-most-once), a throwing teardown is reported via the
existing `console.error` convention and does not abort the remaining unwind, and
a teardown that registers another is drained in a bounded follow-up pass — the
same shape `dispose()` already uses.

### Scope of the rollback

Framework-owned resources only: everything registered through `ctx.on`,
`ctx.text`, `ctx.attr`, `ctx.classed`, `ctx.show`, `ctx.model` and `ctx.cleanup`.
A setup that writes `root.innerHTML`, mutates a global, or fires a request has
performed work SibuJS cannot generically reverse. See
[the lifecycle architecture doc](../architecture/enhancement-lifecycle.md#the-rollback-boundary).

---

## ENH-002 — a disposed root stayed permanently marked as enhanced

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `enhance()` marker lifetime |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`dispose()` tore down every binding and listener but left
`data-sibu-enhanced="true"` on the element. Because `enhance()` refuses any root
already carrying that attribute, a disposed root could never be enhanced again —
the element was left in the forbidden state **ACTIVE MARKER + NO ACTIVE OWNER**,
permanently inert.

### Reproducer

```ts
const dispose1 = enhance(root, setup);
dispose1();

const dispose2 = enhance(root, setup);   // refused at baseline
setN(42);
expect(node.textContent).toBe("42");     // FAILED at baseline: stale value
```

### Root cause

The marker encoded *history* ("this node has been enhanced at some point")
while every consumer read it as *ownership* ("this node currently has an active
enhancement"). Both readers — the `enhance()` idempotency guard and the
`mountIslands()` skip — want ownership.

### Marker contract decision

`data-sibu-enhanced` is **not** public API: it appears in no documentation, and
is read in exactly two places, both asking an ownership question. The evidence
selected **Model B — currently owns an active enhancement**:

| Evidence | Reading |
|---|---|
| `docs/islands.md` | Silent on the marker and on remount — no documented contract to break. |
| `enhance()` returns a disposer | Ownership has an explicit end; the marker should track it. |
| `enhance.ts` guard, `islands.ts` skip | The only two readers, both meaning "is something live here?". |
| `tests/islands.test.ts` (old) | Pinned Model A, but justified as *"no double-wire"* — a rationale that only holds while an enhancement is **active**. After disposal there is nothing to double-wire. |
| `tests/ssr-hardening-islands-progressive.test.ts:408` | The mount/cleanup soak had to **manually strip both markers every iteration** to make remount work — callers were already working around the stickiness. |

So:

| Event | Marker |
|---|---|
| successful `enhance` | added |
| `dispose()` (or DOM-level `dispose(root)`) | removed |
| failed setup | never added |
| re-enhance after disposal | allowed |
| enhance while active | still refused, with the existing dev warning |

### Fix

Remove the attribute on disposal — but **ownership-checked**, not blindly. A
module-level `WeakMap<HTMLElement, symbol>` records which generation owns a
root; a disposer releases the marker only while its own token is still the
current one. A stale generation-1 disposer replayed after the root has been
enhanced again therefore cannot strip generation 2's claim.

The refusal path (`enhance()` on an already-active root) returns an **inert**
disposer that owns nothing, so calling it cannot release the active
enhancement either.

### Follow-on: disposer accumulation

Making roots re-enhanceable made a latent accumulation reachable: every
`enhance()` calls `registerDisposer(root, dispose)`, and `dispose.ts` only ever
clears that node entry inside `dispose(node)`. A long-lived root cycled through
enhance/dispose would retain one dead closure per generation forever.

Added `unregisterDisposer(node, teardown)` to the disposal module (internal —
`registerDisposer` is not exported from the package entry either) and called it
from the enhancement disposer. The soak asserts `checkLeaks()` returns to its
pre-soak baseline after 10 000 cycles, which fails without it.

---

## ENH-003 — `enhanceAll()` stranded earlier enhancements when a later setup threw

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `enhanceAll()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`enhanceAll()` mapped `enhance` over the matched elements. With elements A, B, C
where C's setup throws, `.map()` propagated C's error before `enhanceAll()`
returned. A and B were fully enhanced and *marked active*, but the aggregate
disposer — the only handle the caller was ever offered — never came into
existence. The caller was left with two live enhancements and no way to release
them.

### Reproducer

```ts
expect(() =>
  enhanceAll(".c", (ctx) => {
    ctx.text("@n", () => n());
    ctx.on("@b", "click", () => listenerCalls++);
    if (ctx.root.id === "C") throw new Error("C failed");
  }),
).toThrow("C failed");

expect(document.querySelectorAll("[data-sibu-enhanced]").length).toBe(0);
// FAILED at baseline: 2 — A and B still active and unreachable
```

### Fix

Collect disposers in a loop inside `try`. On failure, unwind the committed
enhancements in **reverse creation order** (C's partial state is already rolled
back by `enhance()` itself, then B, then A — mirroring stack unwinding), clear
the list, and rethrow the original error.

A rollback teardown that throws is reported and skipped; it neither aborts the
remaining rollback nor replaces the original setup error. A test pins this
explicitly: setup error **X** survives a rollback error **Y**.

The success path is unchanged apart from the aggregate disposer now splicing,
making it idempotent.

---

## ISL-001 — island error isolation was control-flow only

| | |
|---|---|
| **Severity** | P2 (inherited from ENH-001) |
| **Subsystem** | `mountIslands()` |
| **Status** | Fixed via ENH-001 |
| **Class** | CONFIRMED BUG |

`mountIslands()` already wrapped `enhance(el, setup)` in `try/catch`, so one
broken island could not take down the page — but because of ENH-001 the failed
island kept its partially-wired effects and listeners alive. The isolation was
real for *control flow* and fictional for *lifecycle*.

No island-side change was required: with `enhance()` transactional, a failed
island now leaves zero live bindings and zero live listeners, is marked neither
enhanced nor hydrated, and its siblings still activate. Pinned by
`tests/islands-hardening-lifecycle.test.ts`, including the vacuity guard that
the failing setup genuinely bound and genuinely fired before it threw.

A comment was added at the call site recording *why* the isolation is now real.

---

## ISL-002 — teardown during setup stranded an island

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `mountIslands()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

Found while tracing ISL-001. `mountIslands()` already guards the *asynchronous*
teardown race — a lazy chunk landing after cleanup re-checks `torndown` before
enhancing. It did not guard the **synchronous** one.

If an island's setup reaches the mount cleanup (directly, or via a parent
component tearing down), `torndown` flips and `disposers.splice(0)` drains a
list that does not yet contain this island's disposer, because `enhance()` has
not returned. Control then returns to `disposers.push(disposeIsland)`, pushing
onto an already-drained list. The island stays fully active, marked enhanced and
hydrated, with its disposer unreachable — exactly the leak the lazy-chunk guard
exists to prevent, reached by a different path.

### Reproducer

```ts
let stop: (() => void) | undefined;
registerIsland("h-self", (ctx) => {
  ctx.text("@v", () => n());
  stop?.();                        // teardown lands mid-setup
});
stop = mountIslands();
await flush();

setN(5);
expect(node.textContent).toBe("0"); // FAILED without the fix: "5" — still live
```

### Fix

Re-check `torndown` after `enhance()` returns; if teardown landed during setup,
dispose the island immediately instead of pushing it. Reuses the existing
`torndown` flag rather than adding a second generation mechanism.

Verified non-vacuous by reverting the guard: the test fails with
`expected '5' to be '0'`.

---

## Island marker semantics: `data-sibu-hydrated` — investigated, deliberately unchanged

`data-sibu-hydrated` was assessed against the same ownership question and
**deliberately left alone**. It is not an ownership marker:

- `ssr.ts` writes it as hydration **provenance**, with three distinct values
  (`"true"`, `"partial"`, `"progressive"`) describing *how* a container was
  hydrated — not whether something is currently live in it.
- `ssr.ts` explicitly excludes it from hydration mismatch diagnostics, alongside
  `data-sibu-ssr` and `data-sibu-island`, i.e. it is treated as a framework
  annotation rather than meaningful markup.
- Nothing anywhere reads it as an activation gate. Island activation is gated
  solely on `data-sibu-enhanced`.

Since it gates nothing, leaving it in place blocks no remount, and removing it
for symmetry would have changed SSR-observable output for no lifecycle benefit.
Island remountability is delivered entirely through the ownership marker.

The one behaviour worth stating explicitly: a **failed** island is never stamped
hydrated, because the attribute is written after `enhance()` returns.

---

## Remount contract

`mountIslands()` cleanup now genuinely releases the DOM: the same markup can be
mounted again, activating a fresh generation with exactly one live binding set,
across the `load`, `idle`, `visible` and `media` strategies. The pre-existing
late-resolution protections are untouched — cleanup before a lazy chunk resolves
still prevents activation entirely, and both that and the new synchronous case
are pinned by tests.

`tests/islands.test.ts` previously asserted the opposite (*"re-mount is
idempotent"*, expecting a second mount to do nothing). It was rewritten to the
selected contract and **split**, so the property its old name actually protected
— mounting twice *without* cleanup must not double-wire an active island — is
now pinned by its own test rather than being conflated with the disposed case.

---

## Investigated and found correct

- **Original setup errors were never swallowed.** `enhance()` propagated them
  by identity at baseline; a test now pins that (`expect(thrown).toBe(original)`).
- **The marker was never set on a failed setup.** `setAttribute` already ran
  after `setup()`, so the "root marked enhanced after failure" half of the
  suspected ENH-001 shape did **not** reproduce. Reported as-is rather than
  inflated.
- **Disposer idempotency.** The `disposed` guard was already correct; double
  dispose remains a no-op and is still pinned.
- **Double enhance while active.** Still refused, still dev-warns, still leaves
  exactly one binding set. Deliberately preserved — this pass is about
  re-enhancement *after* disposal, not concurrent enhancement.
- **Lazy island teardown protection.** The `torndown` re-check after chunk
  resolution was already correct and is unchanged.
- **Setup-returned cleanups.** Already ran exactly once on disposal. When setup
  throws before returning one, none is invented.
- **Progressive strategy scheduling.** Untouched. Only the marker lifetime
  changed, so `cleanup → activation impossible` and
  `cleanup after activation → disposed` both still hold.
- **`ctx.show()` restore.** The saved `prevHidden` restore is registered as a
  teardown, so it now correctly participates in rollback too.

---

## Not in scope / not modified

Router ownership, `ComponentLoader` preload purity, lazy route semantics, query
ownership, SSR request isolation and hydration replacement policy were not
touched. No reproducer in this pass implicated any of them, and the full suite
covering them stayed green.

---

## Result

| Gate | Baseline | After |
|---|---|---|
| Full suite | 371 files / 4602 passed / 1 skipped | 373 files / 4639 passed / 1 skipped |
| Soak | 21 passed / 1 skipped | 23 passed / 1 skipped |
| `tsc` source | 0 errors | 0 errors |
| `tsc` tests | 0 errors | 0 errors |
| `biome check` | clean | clean |

Findings: **ENH-001** (P1), **ENH-002** (P2), **ENH-003** (P2), **ISL-001**
(P2, inherited), **ISL-002** (P2) — all confirmed by failing reproducer and
fixed.
