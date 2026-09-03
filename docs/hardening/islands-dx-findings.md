# Islands / enhancement DX findings

Findings from building a complete chess application as an enhanced SibuJS
island, audited against the source before any production code changed.

Every claim below was verified by reading the implementation, and every defect
was reproduced with a failing test before it was fixed. Friction that turned out
**not** to be a defect is recorded as such, with what was done instead.

Severities: **P0** critical · **P1** high · **P2** medium · **P3** low

## Baseline

| | |
|---|---|
| Package | `sibujs@4.0.1` |
| Node | v24.19.0 · npm 11 · Windows 11 (win32-x64) |
| Vitest | 3.2.7 · jsdom 26 |
| Playwright | 1.61.1 — Chromium, Firefox, WebKit installed |
| Full suite **before** | 449 files, 6 320 passing, 1 skipped |
| `tsc --noEmit` / `biome check` **before** | clean |

The application under audit is `sibujs-chess/app/chess-island.tsx` — a working
board scoring ~8.5/10 for this class of application. Its architecture was
confirmed sound: server-rendered squares, `registerIsland` + `mountIslands`, one
`enhance()` transaction, per-square bindings, no rerender, no VDOM.

---

## Verified against the source, not the prompt

Four claims in the brief did not survive contact with the code and are corrected
here so nothing downstream repeats them:

| Claim | Reality |
|---|---|
| `setupChess(root, ctx)` | An island setup is `EnhanceSetup = (ctx) => void \| (() => void)`. There is no `root` parameter; the element is `ctx.root`. The chess app already calls it correctly. |
| "`ctx.refs()` … existing list helpers" | `ctx.refs()` is a query, not a binding helper. No repeated-binding helper existed on `EnhanceContext`. |
| The floor is Chrome 80 / FF 78 / Safari 14 / Edge 80 | `package.json` declares Chrome ≥ 93, Firefox ≥ 92, Safari ≥ 15.4, Edge ≥ 93, and `tests/hardening-browser-floor.test.ts` enforces it. The **repository's** declared floor was maintained; nothing was changed to accommodate the lower numbers. |
| "Profiling reactive invalidation" is missing | `sibujs/devtools` already receives `signal:create` / `signal:update` for every source. What was missing was documentation, not machinery. |

---

## DX-001 — enhancement bindings were reported as generic effects, with no node

**P1 · fixed**

### Description

Every reactive helper on `EnhanceContext` (`text`, `attr`, `classed`, `show`,
`model`) created its binding with `effect()`. An `effect` subscriber is stamped
`_errorPhase: "effect"` and deliberately carries **no** `_errorNode` — a generic
effect has no DOM position, and attaching one would retain unrelated subtrees.

Every other DOM binding in the runtime (`bindTextNode`, `bindAttribute`, the tag
factory's class/style writers) is created with `reactiveBinding(commit, node)`,
which stamps `_errorPhase: "binding"` and the owning node.

The consequence is only visible on the failure path — the path that matters. A
binding that throws on a **later** run is reported by the notification drain,
which has no other way to know what it was looking at. `reportError()` gives a
node's enclosing `ErrorBoundary` first refusal; with no node, **that branch was
unreachable for every progressive-enhancement binding on the page**, and every
such failure was mislabelled as an effect.

### Reproducer

`tests/enhance-binding-error-metadata.test.ts` — five failing cases before the
fix, e.g.:

```ts
enhance(root, (ctx) => {
  ctx.text("@n", () => {
    if (n() > 0) throw new Error("text boom");
    return n();
  });
});
setN(1);

expect(reports[0].context.phase).toBe("binding"); // was "effect"
expect(reports[0].context.node).toBe(node);       // was undefined
```

### Root cause

`enhance()` predates the `reactiveBinding(commit, ownerNode)` signature and was
never migrated when error metadata was introduced.

### Fix

One private helper, `bindNode(el, commit)`, through which all five helpers now
create their bindings:

```ts
function bindNode(el: HTMLElement, commit: () => void): () => void {
  if (isSSR()) return () => {};
  return reactiveBinding(commit, el);
}
```

The `isSSR()` guard preserves `effect()`'s existing behaviour exactly — side
effects do not run on the server, so a binding created during SSR stays inert.
Without it this would have been a silent behaviour change on the server.

Secondary benefit: `reactiveBinding` allocates fewer closures per binding than
`effect()` (no `onCleanup`, no rerun-drain context), which is why `ctx.each` over
64 squares is not slower than the loop it replaces.

---

## DX-002 — no first-class way to bind many existing elements

**P2 · addressed with a new API**

### Description

Not a defect — the imperative loop is correct and complete. But a 64-square
board needs ~6 bindings per square, and the resulting loop buries the one
interesting fact (which square this is) in repetition. The same shape recurs in
tables, keyboards, calendars, timelines, seat maps and legends.

Confirmed by inspection: `EnhanceContext` had no repeated-binding helper, and
`ctx.refs()` is a query. Nothing in the repository partially solved this.

### Resolution

`ctx.each(target, describe)` — see `src/platform/enhance.ts`. Every field of the
returned descriptor is committed **through the existing `ctx.*` helper**, so
there is no second binding path to keep in step: ownership, disposal,
sanitization, write elision and the DX-001 error metadata are the same objects.

Deliberate limits, so it stays sugar rather than a template language:

- Six fields (`text`, `attr`, `class`, `show`, `on`, `cleanup`) — exactly what
  the context already supports per element. No properties and no styles, because
  `EnhanceContext` has no `prop`/`style` helper to delegate to; adding them here
  would have made `each` a superset of the API it is shorthand for.
- No expression parsing, no interpolation, no `eval` — CSP-safe by construction.
- The callback may return nothing and wire the element imperatively instead;
  `model`, listener options and nested enhancement stay where they were.
- Descriptor mistakes throw in development, naming the index and the key, inside
  `setup` — so `enhance`'s transaction rolls the whole thing back.

Measured cost (`bench/islands-dx.mjs`, 64 squares × 4 bindings): **+9.1% at
setup in production mode**, zero at update time, because the bindings it creates
are the ordinary bindings. Documented as ergonomic sugar, not a mandate.

---

## DX-003 — external mutable state had no documented pattern

**P1 · addressed with a new primitive**

### Description

`chess.js` owns its state internally. The application threaded a revision
signal:

```ts
const [revision, setRevision] = signal(0);
ctx.text("@status", () => { revision(); return status(game); });
game.move(...); setRevision((v) => v + 1);
```

This works, and is the correct mechanism. Three problems with it as the official
answer: the number is meaningless and appears in every getter that has nothing
to do with counting; nothing names the pattern, so every application reinvents
it; and there was no guidance on granularity, so "one revision for everything"
became the default by accident rather than by choice.

Audited: no invalidation primitive existed anywhere in `src/`.

### Resolution

`external()` in `src/core/signals/signal.ts` — a valueless reactive token with
`track()` and `invalidate()`.

Implementation is deliberately thin: it wraps a private `signal(0)` rather than
reimplementing against the reactive core, so batching, the drain,
version-based stabilization, duplicate-runtime coordination and devtools all
behave identically to every other source, with **no second implementation of
those invariants to keep in step**. The counter is never handed out — `track()`
returns `void` — so no consumer can come to depend on the number.

**An `invalidatable(obj)` wrapper was considered and rejected.** It can only
publish changes that go through its own `mutate()`, so a mutation from a library
callback, an internal event handler, or a reference handed elsewhere silently
produces stale UI — the exact failure the explicit call site makes impossible to
overlook. One composable primitive beats two overlapping ones.

Granularity guidance — four architectures compared on complexity, runtime cost,
memory, granularity and integration effort, with measurements and profiling
technique — is in `docs/architecture/external-state.md`.

---

## DX-004 — `enhance()` + `mount()` composition worked, but was untested and undocumented

**P2 · no production change; tests and documentation added**

### Description

The brief expected defects here. There were none. Eleven composition tests
(`tests/islands-enhance-mount-composition.test.ts`) were written against the
existing implementation and **all passed on the first run**:

- the mounted subregion disposes with the island
- removing the island root disposes the mounted subregion
- disposal is idempotent across island, enhancement and mount
- two islands on one page keep separate feature state
- a broken island beside a working one disturbs nothing
- a setup that throws *after* mounting leaves nothing live, and the root is
  enhanceable again
- a `mount()` failure goes to the island error pipeline, not to the caller
- a binding inside the mounted region reports with its own node
- remount produces exactly one mounted region, not two stacked
- `mountIslands()` twice without cleanup does not double-mount

What was missing was the composition pattern itself. Two sharp edges found while
writing the tests, now documented:

1. **`when()` inserts its branch as a sibling of its anchor.** `mount(() =>
   when(...), slot)` therefore unmounts the anchor and leaves the branch behind.
   Wrapping in an element the mount owns fixes it. This is `when`'s documented
   design, not a bug — but it is a trap in the mount-into-a-slot position.
2. **`ctx.show()` and `when()` are not interchangeable.** `show` toggles a node
   that exists (enhance side); `when` creates and destroys (mount side).

`ctx.cleanup(history.unmount)` is the single line that makes the composition
transactional. Registered *before* the risky work, it is also what rolls the
mount back when setup throws later.

---

## DX-005 — a new root-only module is not independently tree-shakeable

**P2 · found by the probe added in this pass · fixed**

### Description

`external()` was first written as its own module, `src/core/signals/external.ts`,
reachable only from the root entry. The build splits `dist/` into shared chunks,
and a module that only one entry point reaches lands in the **index-only** chunk
— which also contains `enhance`, `mountIslands`, `mount`, `each`, `when`,
`store`, `writable`, `ref` and `array`.

The consequence is invisible from the source tree and only appears through the
packed package: a consumer importing `external` from `"sibujs"` pulled the whole
island runtime.

### Reproducer

The `external-only` certification probe added in this pass, bundled against the
packed tarball:

```
esbuild  external-only   77 KB   unexpected subsystems: islands
```

Reproduced identically in esbuild, Rollup, Vite and webpack. `core-minimal`
(signal/derived/effect/batch) was clean at 13 KB in the same run, so the cause
was chunk placement rather than a stray import.

### Root cause

Chunk placement, not a dependency. A control bundle proved it: `store` and
`writable` — both pre-existing exports in the same chunk — produce the same
77 KB bundle carrying the same island marker. Nothing about `external()` caused
it; defining any new root-only module would have done the same.

### Fix

`external()` and `ExternalSource` now live in `src/core/signals/signal.ts`,
which every entry point shares and which is therefore in the small core chunk.
The public API is unchanged — it is exported from `"sibujs"` exactly as before.

```
before   external + signal from the packaged root   77.1 KB, island runtime present
after    external + signal from the packaged root    9.1 KB, island runtime absent
```

The reason is recorded in a comment at the definition, because "why is this
primitive in signal.ts" is otherwise an invitation to move it back.
`tests/treeshaking-islands.test.ts` pins the property against `dist/`, not just
against `src/`, since that is the only place the difference was visible.

---

## Observed, pre-existing, NOT fixed — `sibujs/plugins` ships i18n with the router

**P3 · pre-existing · out of scope**

The certification's `router-only` probe imports from `sibujs/plugins`, and the
i18n singleton marker is present in the output in all four bundlers. This
predates this work: the probe, the barrel and the expectation are all unchanged
here, and `src/plugins/router.ts` does not import i18n — the two are siblings in
one barrel, so the chunk carries both.

Fixing it means changing how `plugins.ts` is chunked or split, which affects the
published entry points and the 157 export-map checks. That is a packaging change
with its own risk budget and does not belong in this pass. Recorded so it is not
mistaken for a regression: the tree-shaking column reads **16/20 clean**, and the
four unclean rows are exactly these.

---

## Investigated and found correct — no change made

| Area | Finding |
|---|---|
| Manual invalidation | No existing primitive; DX-003 added one. Nothing was duplicated. |
| Shared stores between enhanced and mounted regions | Ordinary closure state already works and is per-instance. A store abstraction would have added a way to create the exact global-state bug the closure form avoids. |
| Nested `mount()` inside an enhanced island | Correct today. `dispose()` walks descendants, so removing the island root disposes the mounted subtree; `ctx.cleanup(unmount)` covers the case where the root survives. |
| Accessible dialogs | `createDialogAria` + `createFocusManager` + `machine` are sufficient for a modal in server-rendered markup. `FocusTrap` creates a wrapper element, which suits mounted content rather than enhanced content — documented rather than changed. |
| Island error isolation | Already real lifecycle isolation (ISL-001, prior pass). Re-verified with a broken island beside two live boards, in three browsers. |
| Duplicate activation | `mountIslands()` already skips elements carrying `data-sibu-enhanced="true"`. Verified in-browser under repeated host-navigation cycles. |
| Profiling hook | A development-only effect-execution counter was evaluated and **not added**: it would have to sit on the hot path of every subscriber to be accurate, the six-line manual counter answers the same question with zero production cost, and `sibujs/devtools` already carries the general-purpose hooks. |

---

## Not in scope / deliberately not changed

- **`EnhanceContext` gained no `prop()` or `style()` helper.** The chess board
  drives style through `ctx.attr(el, "style", …)`, which is sanitized. Adding
  writers was outside the verified friction.
- **No state-management abstraction, no DOM reconciliation, no VDOM.** `each`'s
  keyed reconciliation on the mounted side is pre-existing and untouched.
- **No chess rules in the runtime.** `chess.js` is a devDependency used by the
  example only.
- **Browser-support policy unchanged.** The vendored engine is built for the
  declared floor; nothing new uses a higher baseline.
- **No package version change**, no publish, no release, no remote state
  touched.

---

## Result

| | Before | After |
|---|---|---|
| Unit test files | 449 | 457 |
| Unit tests | 6 320 (+1 skipped) | 6 399 (+1 skipped) |
| Browser specs | 11 files | 13 files |
| Browser runs (Chromium/Firefox/WebKit) | 309 | 366 (57 added), all passing |
| `tsc` (src) · `tsc` (tests+entries) · `biome` | clean | clean |
| New public API | — | `external()`, `ExternalSource`, `ctx.each()`, `EachBindings`, `EachEventBindings` |
| Bundle delta | — | `external()` +0.06 KB gz over `signal` + `effect`; `each` inside the existing enhance module |
