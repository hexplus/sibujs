# Streaming / Suspense / Islands / Route-Mismatch Findings

Every finding was reproduced with a failing test before production code changed.
Items investigated and found correct are listed at the end.

Prefixes: **ST** Streaming · **SS** SSR Suspense · **IS** Islands · **RM** Route mismatch
Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

---

## ST-001 — `renderToStream` omitted the SSR provenance marker

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `renderToStream` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`renderToString` stamps `data-sibu-ssr="true"` on every element (unless the node
carries `data-sibu-hydrate`). `renderToStream` never did. The two documented
render paths therefore produced **different HTML for identical input**, despite
the streaming function's own doc comment claiming the "same security posture as
`renderToString`".

Practical impact: an application that streams in production but snapshots with
`renderToString` in tests compares different bytes, and streamed output carries
no SSR provenance marker at all.

### Reproducer

```ts
const el = document.createElement("br");
renderToString(el);                       // '<br data-sibu-ssr="true" />'
await collectStream(renderToStream(el));  // '<br />'
```

### Root cause

The marker is emitted in `renderToString`'s attribute loop; the parallel loop in
`renderToStream` was never given the same step. It survived because the existing
test named *"renderToStream emits the same structure as renderToString"* only
used `toContain` assertions and never actually compared the two outputs.

### Fix

Emit the marker in `renderToStream` under the identical condition. Nothing
consumes the attribute functionally (`collectMismatches` explicitly skips it),
so this is additive and inert — it makes the paths byte-identical.

Also updated the pre-existing test that had encoded the divergent output
(`expect(out).toContain("<br />")`), after verifying against `renderToString`
that the marker was always the correct expectation.

### Regression test

`tests/__probe_tmp.test.ts` — six cases comparing the two paths **byte-for-byte**
across void elements, attributes, nesting, hostile text, fragments, and
`data-sibu-hydrate` suppression. The paths can no longer drift apart silently.

### Remaining risk

Low.

---

## IS-001 — A lazy island resolving after teardown still activated

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `mountIslands` in `src/platform/islands.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`mountIslands()` returns a cleanup that cancels pending schedulers and drains a
`disposers` array. But `activate()`'s async continuation — the one that awaits a
lazy island's dynamic `import()` — never re-checked whether teardown had
happened. A chunk landing after `cleanup()` would:

1. call `enhance(el, setup)`, mutating DOM for a torn-down island; and
2. `disposers.push(...)` onto an array `cleanup()` had **already spliced empty**,
   so the enhancement's own disposer was unreachable forever.

That violates the island lifetime invariant (§75): `DISPOSED` must never become
`ACTIVE`.

Note the `load` strategy makes this trivially reachable — its `schedule()` case
returns a **no-op cancel**, so activation is always in flight by the time
`cleanup()` runs.

### Reproducer

```ts
registerIsland("lazy-late", lazyIsland(() => pendingChunk));
const cleanup = mountIslands(host);
await settle();
cleanup();                       // tear down while the chunk loads

resolveChunk({ default: setup });
await settle();
// Expected: setup never called
// Actual:   setup called, and its disposer is orphaned
```

### Root cause

Cancellation state existed per-scheduler but not for the async activation
continuation.

### Fix

A single `torndown` flag on the `mountIslands` closure, set by the returned
cleanup, checked at the top of `activate()` and again inside the `.then()` after
the chunk resolves. Three lines, no API change.

### Regression test

`tests/ssr-hardening-islands-progressive.test.ts` — "does not activate a lazy
island whose loader resolves after cleanup", with a positive control ("activates
a lazy island from a module default export") so the fix cannot regress into
never activating.

### Remaining risk

Low.

---

## RM-001 — Bootstrap rendered the server's route, not the browser's

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | `hydrateRouter` in `src/plugins/routerSSR.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`hydrateRouter()` created the client router from `window.location` (correct),
then hydrated the component resolved from **`serverState.path`** — the route the
*server* rendered. When the two disagreed, bootstrap ended in exactly the state
the invariant forbids:

```text
location = /b
router   = /b
DOM      = /a      ❌
```

The code comment asserted that "the location-driven resolution reconciles to the
live URL". It did not: the hydrate call never consulted `location`.

Server and client legitimately disagree in production — stale cached HTML, a CDN
serving another route's document, a proxy rewrite, a redirect landing elsewhere,
or a user navigating before the bundle boots.

A second defect sat behind the same code: the hydrate ran inside a dynamic
`import()` continuation with **no staleness guard**, so a bootstrap that lost a
race to a real user navigation would overwrite it.

### Reproducer

```ts
// Server rendered /a; browser is at /b.
hydrateRouter(routes, { container });
await settle();

// Expected: DOM shows /b
// Actual:   DOM shows /a while router and location say /b
```

### Root cause

Two sources of truth for "which route are we on", with the DOM taking the wrong
one.

### Fix — policy: **Model A, live URL wins**

Chosen because it is architecturally free here: SibuJS uses replacement
hydration, so the server subtree is discarded either way. Rendering the live
route costs nothing extra and is the only option that satisfies the coherence
invariant.

1. Resolve from `location.pathname + search + hash` instead of
   `serverState.path`.
2. Guard the async continuation so a superseded bootstrap cannot overwrite a
   newer navigation. **This guard was initially a URL comparison, which RM-002
   later replaced with a navigation-generation check** — see RM-002 for why URL
   equality could not express the invariant.
3. When no route matches the live URL, clear the container through
   `replaceChildrenSafely()` rather than leaving markup for a route the user is
   not on.

No history entry is created by the recovery — verified.

### Regression test

`tests/ssr-hardening-route-mismatch.test.ts` — 10 cases: matched bootstrap,
path mismatch, dynamic-param mismatch, query mismatch, hash mismatch, history
integrity, post-bootstrap navigation, stale-bootstrap-vs-navigation race,
no-server-state fallback, and unmatched-route cleanup.

**Testing note:** the first version of this suite drained only microtasks, so
`hydrateRouter`'s dynamic `import()` never settled and the matched-route test
passed *vacuously* (the server markup happened to equal the expectation). The
helper now awaits macrotasks.

### Remaining risk

Not verified in real browsers — see the readiness document.

---

## RM-002 — Stale bootstrap could regain commit permission via an ABA navigation

| | |
|---|---|
| **Severity** | P1 |
| **Subsystem** | SSR/client bootstrap ownership (`hydrateRouter`) |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

Filed separately from RM-001 rather than folded into it. RM-001 was a
*route-selection* defect — the bootstrap rendered the wrong route. RM-002 is an
*ownership* defect: the bootstrap renders the right route but has no right to
commit it. They have different root causes and different fixes, and RM-001's fix
introduced the guard that RM-002 corrects.

### Description

The RM-001 fix guarded the async bootstrap by capturing the URL at start and
comparing it after the dynamic import resolved. That defends the simple case
(`/b` → navigate `/c` → bootstrap resolves) but not an **ABA** sequence:

```text
bootstrap   generation 10 → /b   (import pending)
navigation  generation 11 → /c
navigation  generation 12 → /b   ← same URL, newer generation
bootstrap   generation 10 resolves
```

At that point `nowUrl === liveUrl`, so the guard passes and the stale bootstrap
calls `hydrate()`. Because SibuJS uses **replacement hydration**, that replaces
the entire container — destroying the signals, effects, event listeners, loaded
data, and lifecycle owned by the generation-12 instance.

The damage is invisible to the obvious assertions: `location`, `route()`, and
`textContent` all still read `/b`. Only component-instance identity reveals that
the wrong generation owns the DOM.

### Reproducer

`destroyRouter()` during a pending bootstrap is the same defect with a wider
window, and **failed against the RM-001 implementation**:

```ts
hydrateRouter(routes, { container });
destroyRouter();
await settle();
// Expected: container untouched
// Actual:   the bootstrap committed into a torn-down router's container
```

The ownership primitive is proved directly:

```ts
await navigate("/b");
const url = location.pathname, epoch = __getNavigationEpoch();
await navigate("/c");
await navigate("/b");

expect(location.pathname).toBe(url);                    // URL cannot distinguish
expect(__getNavigationEpoch()).toBeGreaterThan(epoch);  // generation can
```

### Root cause

Conflating two responsibilities. The live URL answers *which route to render*;
it cannot answer *whether this async work may still commit*. That second
question is temporal, and `/b` at generation 10 and `/b` at generation 12 are
different moments wearing the same string.

### Fix

Reused the client router's existing supersession discipline rather than adding
an SSR-only mechanism. `SibuRouter` gains an internal monotonic `navEpoch`,
advanced at the **commit boundary** — the same place the router already enforces
"only the active navigation may commit" — and on `destroy()`. The router's own
initial location resolution is excluded via an internal `initialResolution`
flag, because it establishes the bootstrap's route rather than superseding it.

`hydrateRouter()` captures the epoch before the async gap and re-checks it
immediately before `hydrate()`, with no further `await` in between. Exposed as
`__getNavigationEpoch()`, documented `@internal`; no public API added.

The epoch lives on the router instance, not in a module global, so multiple
routers and SSR request isolation are unaffected.

### Regression test

`tests/ssr-hardening-bootstrap-aba.test.ts` — 12 cases: normal bootstrap, simple
supersession, ABA, multiple ABA, query ABA, router destroy, an RM-001
non-regression check, and five direct proofs that the generation advances across
round trips where the URL does not.

**Honest limitation:** the end-to-end ABA cases (C, D, E) pass both before and
after the fix. `hydrateRouter`'s dynamic import is warm — `routerSSR` already
imports `platform/ssr` statically — so its continuation fires on the first
macrotask, before two navigations can complete, and the URL guard rejected it
during the `/c` phase instead. The window is real but too narrow to stage
reliably in this harness. Case F (destroy) is the case that genuinely failed
before, and the generation proofs establish that URL equality is structurally
incapable of expressing this invariant regardless of timing.

Two earlier drafts of these tests passed *vacuously* — one captured the "owner"
after letting the bootstrap resolve, and one used `class="page"` on the inert
server markup so `querySelector(".page")` matched the wrong node. Both are noted
in `tests/__order_probe.test.ts`, which pins the harness timing that makes such
tests meaningful.

### Remaining risk

Low. Not verified in real browsers, where import timing differs and the window
may be wider.

---

## ST-002 — `renderToSuspenseStream` waits for all boundaries before flushing any

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | `renderToSuspenseStream` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

Not a defect, but it contradicts what "streaming SSR" usually implies.

```ts
yield* renderToStream(element);           // shell, tree order
const resolved = await Promise.all(pendingBoundaries);   // ← waits for ALL
for (const { id, html } of resolved) { ... }             // ← array order
```

Consequences:

- **Ordering is deterministic**: boundaries are emitted in the order they were
  passed, regardless of which resolved first. Verified with controlled promises.
- **But there is no per-boundary progressive flush.** One slow boundary delays
  every other boundary's content, including ones that resolved immediately.
  `Promise.all` also means the shell is followed by nothing until the slowest
  boundary settles.

This is a real ceiling on what SibuJS streaming buys you today: you get an early
shell, then one batched flush — not incremental delivery per boundary.

---

## ST-003 — `renderToStream` contains no async boundary handling

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | `renderToStream` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

`renderToStream()` is a synchronous depth-first walk of an **already-built DOM
tree**, expressed as an async generator. It contains no promises and no async
boundaries. Ordering is therefore trivially tree order, and several questions the
hardening plan poses about out-of-order resolution inside the stream do not apply
to this function — they apply only to `renderToSuspenseStream`.

Cancellation works through the generator protocol: `generator.return()` and
`ReadableStream.cancel()` both terminate it, and no further chunks are produced.

---

## SS-001 — Suspense rejection renders the fallback, not an error

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | `ssrSuspense` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

On rejection *or* timeout (default 30 s), `ssrSuspense` resolves its promise to
the **fallback HTML** rather than propagating the error:

- the stream never hangs and always produces a deterministic swap payload;
- `promise.catch(noop)` prevents an unhandled rejection when the caller never
  awaits;
- a development `console.warn` reports the cause;
- one failing boundary cannot affect its siblings.

The trade: the client receives a boundary that silently shows its loading state
forever, with no error signal in the markup. Applications needing a visible error
state must render one inside `content()` rather than relying on rejection.

---

## Investigated and found correct

Tested, confirmed, **not changed**.

| Area | Result |
|---|---|
| **Streaming escaping (security gate)** | **PASS.** Hostile payloads in streamed text, attributes, Suspense content, and Suspense fallbacks are all escaped; `<script>`/`<style>` elements are stripped; serialized state emitted alongside a stream keeps exactly one `<script>` pair. |
| **Suspense id injection** | **PASS.** Ids are allowlisted to `[A-Za-z0-9_-]+`; `suspenseSwapScript` throws on anything else, and the stream drops non-conforming ids rather than emitting them. |
| **Streaming cross-request isolation** | **PASS.** Two requests interleaved as B1→A2→B2→A1 kept entirely separate output; 50 concurrent streams released in reverse order produced no id collision and no foreign markers. |
| **Suspense sibling isolation** | **PASS.** Out-of-order resolution lands each payload in its own boundary; ids are unique across 50 boundaries in one request. |
| **Nested Suspense** | **PASS.** Inner and outer boundaries get distinct ids; inner content is emitted correctly. |
| **Terminal-state safety** | **PASS.** `ReadableStream.cancel()` and `generator.return()` both stop output; a boundary resolving after its stream was abandoned emits nothing and raises no unhandled rejection. Verified across 200 cancelled streams with late resolution. |
| **Island activation-once** | **PASS** for every supported strategy (`load`, `idle`, `visible`, `interaction`), including a deliberate visibility+interaction race. |
| **Island cancellation** | **PASS.** `cleanup()` cancels pending idle and visibility activation and removes interaction listeners. |
| **Island listener hygiene** | **PASS.** 200 mount/cleanup cycles remove every listener type at least as often as it is added. |
| **Missing browser APIs** | **PASS.** No `IntersectionObserver` → eager activation; no `requestIdleCallback` → timeout fallback; no root → no-op cleanup. Deterministic, never a crash. |
| **Island error isolation** | **PASS.** A throwing setup and a failing lazy import are both reported and contained; siblings still mount; no unhandled rejection. |
| **`hydrateProgressively`** | **PASS.** Activates once on intersection, preserves the island marker, and `cleanup()` prevents later activation. |
