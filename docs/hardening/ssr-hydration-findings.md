# SSR / Hydration Hardening Findings

Every finding was reproduced with a failing test **before** production code
changed. Items investigated and found correct are listed at the end; no code was
changed for them.

Prefixes: **S** SSR · **H** Hydration · **I** Islands · **RS** Router-SSR
Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

---

## H-001 — `hydrate()` orphaned the previous client tree on re-hydration

| | |
|---|---|
| **Severity** | P2 |
| **Subsystem** | `hydrate()` in `src/platform/ssr.ts` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG |

### Description

`hydrate()` committed with a bare `container.replaceChildren(clientTree)`.
On a *first* hydration the outgoing children are inert server markup, so nothing
is lost. On a **second** hydration of the same container — a re-render after a
route change, a hot reload, or a deliberate re-hydrate — the outgoing children
are a SibuJS-owned client tree whose bindings, listeners, and lifecycle hooks
were detached unreachable and never torn down.

This is the same defect class already fixed in `Suspense`, `lazy()`, and
`ErrorBoundary` during the framework hardening pass. `hydrate()` was missed.

### Reproducer

```ts
hydrate(() => { const el = div("first"); registerDisposer(el, cleanup); return el; }, container);
hydrate(() => div("second"), container);

// Expected: cleanup called once
// Actual:   cleanup never called — the first tree leaked
```

### Root cause

A native DOM removal API used on a SibuJS-owned subtree, bypassing disposal.

### Fix

Routed the commit through the existing `replaceChildrenSafely()` helper, which
disposes outgoing children (skipping any carried into the new set) before the
native replace. First-time hydration is unaffected.

The same treatment was applied to the two `replaceWith()` sites in
`hydrateProgressively()` via a small `disposeAndReplace()` helper.

### Regression test

`tests/ssr-hardening-hydration.test.ts` — "disposes SibuJS-owned content
replaced by a second hydrate() call", plus a 200-cycle binding-count test.

### Remaining risk

Low.

---

## H-002 — The `"text"` mismatch diagnostic was unreachable

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `collectMismatches()` |
| **Status** | Fixed |
| **Class** | CONFIRMED BUG (documentation/DX) |

### Description

`HydrationMismatch.kind` publicly declares `"text"`, but the walker only
descended through **element** children and never compared text. `grep 'kind:
"text"'` returned nothing — the variant could not occur.

The practical effect: the single most common real-world mismatch — server and
client disagreeing on *data*, rendering `Hello` vs `Goodbye` — was silently
undetected, while a trivial attribute difference was reported.

### Reproducer

```ts
container.innerHTML = "<span>Hello</span>";
hydrate(() => span("Goodbye"), container, { diagnostics: true, onMismatch });
// Expected: onMismatch called with kind "text"
// Actual:   never called
```

### Root cause

A deliberate simplification ("text-node diffs would be noisy") that was never
reflected in the public type.

### Fix

Added an aggregate direct-text comparison per node, before descending. Compares
only *direct* text children (so descendant text is attributed to its own owner)
with whitespace normalised (so HTML source formatting does not produce false
positives). The declared `"text"` variant is now reachable and accurate.

Recovery behaviour is unchanged — this affects reporting only.

### Regression test

`tests/ssr-hardening-hydration.test.ts` — "reports a text mismatch with both
values", alongside a test that diagnostics stay silent when trees agree.

### Remaining risk

Low. Whitespace normalisation means a whitespace-only difference is not
reported; that is intentional.

---

## H-003 — Hydration replaces rather than adopts server DOM

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | `hydrate()` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

Not a bug, but the most consequential fact in this audit, and it directly
contradicts the plan's default expectation (§74: hydration "must not normally
become destroy-everything-and-recreate").

`hydrate()` discards the server subtree and builds the client tree fresh. DOM
identity is not preserved. The rationale is sound — SibuJS bindings are wired to
the nodes `component()` produced, so adopting server nodes would leave the
visible DOM permanently frozen — but the consequences must be understood:

- pre-hydration user input, checkbox state, and focus are **discarded**;
- no hydration performance benefit; the client tree is built regardless;
- conversely, **mismatches cannot corrupt the DOM** — whole categories of
  hydration bug are structurally impossible.

Fully specified in [hydration.md](../architecture/hydration.md), with the
consequences pinned by tests in jsdom and in all three browser engines.

---

## S-001 — SSR requires a DOM implementation

| | |
|---|---|
| **Severity** | — |
| **Subsystem** | `renderToString` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC |

`renderToString` takes a real DOM node, so building the tree needs
`document.createElement`. SibuJS SSR therefore requires jsdom / happy-dom /
linkedom on the server, unlike frameworks that render straight to a string.

Verified in a genuine bare-Node environment: module import, state serialization,
escaping, the SSR context, and **server route resolution** all work without a
DOM; element construction does not.

Deployment implications (memory per process, no DOM-less edge runtimes) are
documented in [ssr.md](../architecture/ssr.md).

---

## S-002 — `withSSR()` is not request-scoped

| | |
|---|---|
| **Severity** | P3 |
| **Subsystem** | `src/core/ssr-context.ts` |
| **Status** | Documented |
| **Class** | DESIGN CHARACTERISTIC / footgun |

`runInSSRContext()` creates a fresh AsyncLocalStorage-backed store per request.
`withSSR()` merely flips the flag on whatever store is current — outside a
request scope, the process-global fallback.

Both are exported, similarly named, and only one is safe for a concurrent
server. Pinned by a test and documented; no code change, since `withSSR` is
correct for its intended one-shot use.

---

## Investigated and found correct

Tested, confirmed, **not changed**. Several are exactly the areas the plan flags
as release-blocking.

| Area | Result |
|---|---|
| **Cross-request isolation** | **PASS.** AsyncLocalStorage-backed. Verified with deliberately interleaved renders (A parks, B runs to completion, A resumes) and 100 concurrent renders released in reverse order — no request saw another's state, counter, cache, or markup. |
| **SSR escaping** | **PASS.** Hostile payloads in text, attributes, data attributes, and nested content are all entity-encoded. Unicode and emoji survive intact. |
| **Serialized-state escaping** | **PASS.** `</script>`, `<!--`, `-->`, U+2028, U+2029, quotes, and backslashes cannot terminate the script context; exactly one `<script>`/`</script>` pair is emitted; values round-trip losslessly through `JSON.parse`. A hostile `nonce` is escaped. Oversized payloads throw rather than emit. |
| **No browser globals at import** | **PASS.** The SSR module imports cleanly in bare Node. |
| **Server/client route parity** | **PASS.** 8 URLs (including encoded, Unicode, query, deep nesting, unmatched) produce identical path, params, and query on both routers. The classic `/users/new` vs `/users/:id` divergence does **not** occur — both pick the static route. Holds across a 1 000-route table. |
| **Malformed percent-encoding** | **PASS.** Neither router crashes; `safeDecode` returns the raw input. |
| **Server-side redirect loops** | **PASS.** Bounded, terminate without throwing. |
| **No duplicate DOM after hydration** | **PASS.** Exactly one copy of content and of list rows. |
| **No duplicate effects/listeners** | **PASS.** One callback per real click and one re-render per signal write, verified in all three engines. |
| **Mismatch recovery** | **PASS.** Text, tag, missing node, extra node, attribute, and list-order mismatches all resolve to the client tree with exactly one root child and no corrupted structure. |
| **Hydration memory** | **PASS.** Binding count flat across 200 hydrate/dispose cycles. |
| **Island isolation** | **PASS.** Hydrating one island leaves others' server markup untouched; a second island hydrated later does not re-run the first; 25 islands stay independent; unknown ids are ignored; an island removed before activation is never hydrated. |
| **SSR → hydration → client routing** | **PASS.** Client navigation, nested-child RouterLink, and back-traversal all work after hydration, with no full page reload and **no extra history entry** from router bootstrap. |
