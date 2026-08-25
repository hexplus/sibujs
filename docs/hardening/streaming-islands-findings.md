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
2. Guard the async continuation: re-read the live URL when the chunk lands and
   bail if it changed, so a superseded bootstrap cannot overwrite a newer
   navigation. Compared against `location` rather than router state, because at
   bootstrap the router is still resolving its initial route asynchronously and
   its path is not yet authoritative.
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
