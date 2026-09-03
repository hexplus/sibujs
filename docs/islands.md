# Reactive islands & progressive enhancement

SibuJS can render whole apps — but its sharpest use is **adding fine-grained
reactivity to HTML you already have, with no build step.** You server-render a
page (from any backend or static generator), drop in one `<script>` tag, and
wire reactivity onto specific elements. No JSX, no compiler, no bundler, no
virtual DOM.

This guide covers the three rendering modes, the `enhance()` primitive, the
island runtime that activates them on demand, and how to build a substantial
interactive feature out of them.

---

## Contents

1. [The three rendering modes](#the-three-rendering-modes)
2. [Why a dense interactive board is the ideal island](#why-a-dense-interactive-board-is-the-ideal-island)
3. [`enhance(target, setup)` and the `EnhanceContext`](#enhancetarget-setup)
4. [Repeated enhancement — `ctx.each`](#repeated-enhancement--ctxeach)
5. [External mutable state — `external()`](#external-mutable-state--external)
6. [`enhance()` vs `mount()`](#enhance-vs-mount)
7. [Combining them inside one feature](#combining-them-inside-one-feature)
8. [Feature-local state](#feature-local-state)
9. [Granular vs broad invalidation](#granular-vs-broad-invalidation)
10. [Islands: lifecycle and cleanup](#islands--partial-hydration-as-a-runtime-primitive)
11. [Accessible conditional UI](#accessible-conditional-ui)
12. [Host-framework interoperability](#host-framework-interoperability)
13. [Performance profiling](#performance-profiling)
14. [The chess reference application](#the-chess-reference-application)
15. [Common mistakes](#common-mistakes)
16. [Architecture decision table](#architecture-decision-table)

---

## The three rendering modes

| Mode | What it does | Use when |
| --- | --- | --- |
| `mount(component, container)` | Renders a **fresh** tree into a container. | The client owns the UI; there's no server HTML to reuse. |
| `hydrate(component, container)` | Renders the component and **replaces** the server markup, taking ownership. | You server-rendered with the *same* component and want a full client takeover. |
| `enhance(target, setup)` | **Attaches** reactivity to the existing server markup, in place. | You have server HTML and want surgical interactivity without re-rendering it. |

`enhance` is the one to reach for in an HTML-first app. It never recreates static
DOM: it binds signals and effects to the nodes the server already sent, drives
only the dynamic parts, and ties every binding to disposal — so static content
never re-paints and there's no flash.

---

## Why a dense interactive board is the ideal island

A chessboard is the shape this model is best at, and it is worth understanding
why, because the same reasoning applies to tables, keyboards, calendars,
timelines, seat maps and diagrams.

- **The meaningful DOM already exists.** 64 squares are 64 squares whether or not
  JavaScript ran. The server can render them; a search engine can read them;
  they work as a static picture of a position with no client code at all.
- **Node identity carries state the framework does not own.** Focus, text
  selection, scroll position, an in-flight CSS transition, an ARIA relationship
  pointing at an id. Every one of those is lost when a node is replaced. Enhance
  never replaces a node, so none of them are ever at risk.
- **Changes are sparse and local.** A move changes two squares. A component
  framework that re-renders the board and diffs it does work proportional to the
  board; fine-grained bindings do work proportional to the change.
- **The interaction is dense but the structure is fixed.** Elements are not
  created or destroyed, so there is nothing for a reconciler to reconcile.

The move history underneath the board is the exact opposite — the number of rows
is unknown until the game is played — and that is what `mount()` is for. Most
real features contain both, which is why [combining
them](#combining-them-inside-one-feature) has its own section.

---

## `enhance(target, setup)`

```ts
import { enhance, signal } from "sibujs"; // also on window.Sibu via the CDN build

// server HTML:
//   <div data-counter>
//     <output data-ref="n">0</output>
//     <button data-ref="inc">+1</button>
//   </div>

const [n, setN] = signal(0);

enhance("[data-counter]", (ctx) => {
  ctx.text("@n", () => n());                 // drive existing <output> text
  ctx.on("@inc", "click", () => setN((v) => v + 1));
});
```

`enhance` returns a `dispose()` function; disposal is also wired to the element,
so removing its subtree cleans everything up automatically.

### Target resolution

Every helper accepts a target resolved against the enhanced root:

- `"@name"` → a descendant marked `data-ref="name"` (the ergonomic form).
- any other string → a raw CSS selector, queried within the root.
- an `Element` → used as-is.
- `null` → the root element itself.

### The `EnhanceContext`

| Helper | Purpose |
| --- | --- |
| `ctx.root` | The enhanced element. |
| `ctx.ref(target)` / `ctx.refs(target)` | Query a descendant / all descendants. |
| `ctx.on(target, event, handler, options?)` | Auto-removed event listener. |
| `ctx.text(target, () => value)` | Reactive `textContent`. |
| `ctx.attr(target, name, () => value)` | Reactive attribute (`null`/`undefined` removes; booleans serialize literally, so `aria-expanded` reads `"true"`/`"false"`). |
| `ctx.classed(target, name, () => bool)` | Reactive class toggle. |
| `ctx.show(target, () => bool)` | Reactive visibility (toggles the `hidden` property). |
| `ctx.model(target, [get, set], options?)` | Two-way bind a form control (handles checkbox, number, `<select multiple>`). |
| `ctx.each(target, describe)` | [Bind many existing elements at once.](#repeated-enhancement--ctxeach) |
| `ctx.cleanup(fn)` | Register arbitrary teardown. |

Use `enhanceAll(selector, setup)` to enhance every match with one disposer.

Every reactive helper creates **one binding per call**, stamped with the element
it owns. A binding that throws is reported through the runtime error pipeline as
a `"binding"` carrying its node, so an enclosing `ErrorBoundary` can claim it —
identical to the bindings the tag factory creates.

### Lifecycle: setup is a transaction

**If your setup throws, nothing it wired stays alive.** Every binding, listener
and cleanup registered through `ctx` before the throw is torn down, and the
original error is rethrown unchanged for you to handle:

```ts
try {
  enhance("[data-widget]", (ctx) => {
    ctx.on("@save", "click", save);
    throw new Error("bad config");
  });
} catch (err) {
  // No listener was left attached, no effect is still subscribed,
  // and every ctx.cleanup() you registered has already run.
}
```

What rolls back is what SibuJS owns: `ctx.on`, `ctx.text`, `ctx.attr`,
`ctx.classed`, `ctx.show`, `ctx.model`, `ctx.each`, `ctx.cleanup`, and a cleanup
your setup returned. What SibuJS **cannot** reverse is work you did outside those
helpers — writing `root.innerHTML`, mutating your own objects, firing a request,
or a value a binding already wrote before the throw. If setup must undo that too,
register the undo with `ctx.cleanup()` **as you go**; registered cleanups run
during rollback. That is also how you make a nested `mount()` part of the
transaction.

A failed setup claims nothing, so **retrying is legal** — fix the cause and call
`enhance()` again on the same element.

### Disposal and re-enhancement

`enhance()` marks the element it owns with `data-sibu-enhanced="true"`. That
marker tracks *current ownership*, not history:

| Event | Marker |
| --- | --- |
| successful `enhance()` | added |
| `dispose()` | removed |
| setup threw | never added |

So a **disposed element can be enhanced again** — useful for re-initialising a
widget after a client-side navigation, or remounting islands. Enhancing an
element that is *still active* is refused (with a dev warning) so you can never
end up with two competing sets of listeners on one node.

`enhanceAll()` behaves as one transaction across the whole collection: if any
element's setup throws, the ones already enhanced are rolled back and the
original error is rethrown — you are never left holding live enhancements
without a disposer.

### Avoiding a hydration flash

`enhance` never re-paints static content: a binding whose value already matches
the server markup writes nothing. To keep it that way, **seed signals from the
value the server rendered** so the first run is a no-op:

```ts
// server: <b data-ref="n">42</b>
const [n, setN] = signal(42); // matches the server → no first-paint flash
```

Intentionally changing server content on activation (e.g. swapping a
`Loading…` placeholder for live data) is a perfectly normal progressive-
enhancement pattern — it just works, with no warning. Seeding only matters when
you *don't* want a flash.

---

## Repeated enhancement — `ctx.each`

A board, a table, a keyboard, a legend, a timeline: many existing elements, each
needing several bindings. Written out by hand that is a loop of `ctx.*` calls
where the interesting part — which square this is — is buried in the repetition.

`ctx.each` takes the loop and gives back a description:

```ts
ctx.each<HTMLButtonElement>("@square", (el, index) => {
  const square = el.dataset.square as Square;

  return {
    text: () => pieceAt(square),
    class: {
      selected: () => selected() === square,
      legal: () => legalMoves().has(square),
    },
    attr: {
      "aria-label": () => describe(square),
      "aria-selected": () => selected() === square,
    },
    on: {
      click: () => choose(square),
      keydown: (event) => handleKey(event, square),
    },
    cleanup: () => releaseWhateverThisSquareOpened(),
  };
});
```

**It is sugar, and deliberately nothing more.** Every field is committed through
the matching `ctx.*` helper, so ownership, disposal, attribute sanitization,
write elision and error metadata are the same objects as the hand-written form.
There is no expression parsing, no string interpolation, no `eval` — every value
is a function you wrote, which is what keeps it CSP-safe and fully type-checked.

| | |
| --- | --- |
| Targets | A `@ref`/CSS selector (resolved with `ctx.refs`), or any iterable of elements — an array, a `NodeList`, an `HTMLCollection`. |
| Callback | `(element, index) => EachBindings \| void`, called once per element in document order. |
| Fields | `text`, `attr`, `class`, `show`, `on`, `cleanup`. |
| Zero matches | A silent no-op. An empty list is a legitimate state, not a mistake. |
| Called twice | Two independent sets of bindings — exactly like calling `ctx.text()` twice on one node. It does not track what a previous call attached. |
| Node identity | Nothing is created, replaced, moved or re-parented. |
| Dev errors | An unknown key or a non-function value throws with the element's index and the offending key, inside `setup`, so the whole enhancement rolls back. |

### What it deliberately does not cover

`model`, listener options, a nested `enhance` — anything that is not a plain
per-element binding. The callback receives the element, so reach for the ordinary
helper right there:

```ts
ctx.each<HTMLInputElement>("@cell", (el, i) => {
  ctx.model(el, cellState[i]);                       // two-way binding
  ctx.on(el, "wheel", onWheel, { passive: true });   // listener options
  return { class: { invalid: () => !isValid(i) } };  // …and a descriptor too
});
```

Keeping the descriptor small is what stops it becoming a second template
language. If a binding is unusual enough that the descriptor cannot express it,
writing it out is clearer anyway.

### Is it slower?

Marginally, at setup only, and never at update time — the bindings it creates
*are* the ordinary bindings. Measured on a 64-square board with 4 bindings each
(`npm run bench:islands-dx`, Node 24 / jsdom):

```
64 squares × 4 bindings — direct ctx.* calls    299 µs
64 squares × 4 bindings — ctx.each              327 µs   (+9.1%, production mode)
```

That is ~0.1 µs per binding, paid once when the island activates. In development
the descriptor validation adds more (about +23% in the same benchmark); a
production build drops it. If you are binding tens of thousands of elements in a
measured hot path, write the loop; otherwise use `each` and keep the intent
visible.

---

## External mutable state — `external()`

SibuJS tracks reads of **its own** signals. A chess engine, a canvas scene, an
editor document, a socket-owned cache — those keep state in objects the runtime
never sees written. It cannot track them, and it does not pretend to.

`external()` is the seam. It is a reactive token with **no value**: consumers
declare that they read the outside world, and the mutation site declares that
the outside world changed.

```ts
import { external } from "sibujs";
import { Chess } from "chess.js";

const game = new Chess();      // owns the rules and the mutable state
const moved = external();      // owns "something changed"

ctx.text("@status", () => {
  moved.track();               // this binding reads the engine
  return game.isCheckmate() ? "Checkmate" : `${game.turn()} to move`;
});

game.move({ from: "e2", to: "e4" });
moved.invalidate();            // every consumer above re-reads
```

| Guarantee | |
| --- | --- |
| No proxying, cloning or diffing | It holds no reference to your object. |
| Batching | `invalidate()` is a signal write: a burst inside one `batch()` notifies once. |
| Works everywhere a signal does | Bindings, `effect()`, `derived()` — including `derived({ equals })` stopping propagation. |
| Ownership | A disposed effect, binding or island is **never** invalidated. |
| Errors | A throwing consumer is reported with its own phase and node; its siblings still run. |
| Size | ~60 bytes gzipped on top of `signal` + `effect`. Tree-shakes out if unused. |

### Why two calls instead of a wrapper

There is deliberately no `invalidatable(obj)` wrapper with `read`/`mutate`
methods. It would add a second way to express the same thing, and it would be
weaker: it can only publish changes that go through *its* `mutate()`, so any
mutation from a callback, an event handler inside the library, or a reference
you handed elsewhere silently produces stale UI — the exact failure the explicit
call site makes impossible to overlook. One low-level primitive composes; two
overlapping ones have to be chosen between.

### Why not a revision signal

You can build this out of `signal(0)` and `setRevision((v) => v + 1)`, and that
is what applications did before this primitive existed. The number is
meaningless: nothing reads it, it appears in every getter that has nothing to do
with counting, and it invites the reader to wonder what revision 7 means. The
same mechanism with the number removed says what it does.

Full treatment of invalidation domains, granularity and profiling:
[`docs/architecture/external-state.md`](architecture/external-state.md).

---

## `enhance()` vs `mount()`

### Prefer `enhance()` when

- The meaningful DOM already exists (server-rendered, or in a template you
  control).
- Progressive enhancement matters — the page should be useful before, or
  without, JavaScript.
- Node identity must be preserved: focus, selection, scroll, an in-flight
  transition, an `id` something else points at.
- The UI is mostly *behaviour and bindings attached to durable markup*.

### Prefer `mount()` when

- The client creates an unknown or frequently changing number of nodes.
- The region is naturally a component with props.
- List insertion and removal dominate the feature (`each`'s keyed reconciliation
  is exactly this).
- There is nothing on the server to attach to.

### Combine them when

- A durable server-rendered shell contains dynamic subregions.
- A board, form, diagram, table or media player is enhanced, while history,
  menus, notifications, results or filters are mounted.

---

## Combining them inside one feature

The composition below is tested in
[`tests/islands-enhance-mount-composition.test.ts`](../tests/islands-enhance-mount-composition.test.ts)
and used for real in the chess example.

```ts
registerIsland("chess", (ctx) => {
  // One feature, one state object — created here, so it is per-instance.
  const feature = createChessFeature();

  // 1. ENHANCE what the server already rendered.
  ctx.each("@square", (el) => ({ /* … */ }));
  ctx.text("@status", feature.statusText);

  // 2. MOUNT the region whose node count the server could not know.
  const slot = ctx.ref("@history");
  slot.textContent = "";                  // the client owns this region now
  const history = mount(
    () =>
      div(
        when(
          () => feature.historyRows().length > 0,
          () => ol(each(feature.historyRows, (row) => li(() => row().san), { key: (r) => r.n })),
          () => p("No moves yet."),
        ),
      ),
    slot,
  );

  // 3. ONE lifecycle boundary owns both.
  ctx.cleanup(history.unmount);
});
```

Note the island setup signature: `(ctx) => …`. The enhanced element is
`ctx.root`; there is no separate `root` parameter.

### What this guarantees

| | |
| --- | --- |
| Nested disposal | `ctx.cleanup(history.unmount)` is what ties them together. Disposing the island — or `dispose(islandRoot)`, or removing the root — unmounts the region. |
| Idempotence | Every disposer in the chain is idempotent; disposing twice runs cleanups once. |
| No hidden globals | `createChessFeature()` runs per island, so two instances share nothing. |
| Ownership boundaries | The mounted region owns only what it created, inside the container you gave it. Sibling server markup is never adopted, moved or removed — after disposal the shell is byte-for-byte what the server sent. |
| Failure partway through | If setup throws *after* mounting, the cleanup registered above already ran, so nothing survives — provided you registered it **before** the risky work. |
| Mount failures | A `mount()` into a missing container throws inside setup, so the island's transaction rolls back and the error goes to the island error pipeline. It never escapes to the caller of `mountIslands()`. |

### Two gotchas worth knowing

- **`when()` inserts its branch as a sibling of its anchor.** Wrap it in an
  element the mount owns (`div(when(...))`), or unmounting removes the anchor and
  leaves the branch behind.
- **`ctx.show()` and `when()` are not interchangeable.** `ctx.show` toggles a node
  that already exists — the enhanced side. `when` creates and destroys nodes —
  the mounted side. Choosing by which side of the boundary you are on gets it
  right every time.

---

## Feature-local state

```ts
registerIsland("chess", (ctx) => {
  const game = new Chess();     // ✓ one per island element
  const changed = external();
  const [selected, setSelected] = signal(null);
  …
});
```

versus:

```ts
const game = new Chess();       // ✗ shared by every instance on the page
registerIsland("chess", (ctx) => { … });
```

State created inside the setup is per-instance, dies with the island, and needs
no keys, ids or registry. Module state is shared by every instance, survives
disposal, and is the most common cause of "the second widget on the page behaves
strangely".

If two islands genuinely must share state, create it in one place and pass it in
when you register — but be deliberate about it, and remember that whatever you
share also outlives disposal.

---

## Granular vs broad invalidation

Three architectures, all supported, all reasonable in the right place:

| Architecture | Update granularity | When |
| --- | --- | --- |
| One `external()` for the whole engine | All consumers | The default. Correct by construction. |
| Several `external()` domains | Per subsystem | When two parts change at different *rates* (a clock vs a board). |
| One `signal` per cell | Per cell | On the hot path — state that changes on pointer/keyboard input. |

Measured on a 64-cell board (`npm run bench:islands-dx`): broad invalidation
costs ~16 µs per move, granular ~4.7 µs. Both are far under a frame. **For a
small fixed grid, broad invalidation is not a performance problem** — reach for
granularity when the update *rate* is high, not when the collection is large.

The trick that makes per-cell state cheap: recompute every cell and write them
all. Signal equality turns unchanged writes into no-ops, so writing 64 values
wakes only the bindings that actually changed — granularity without computing a
diff yourself.

Full comparison, including a normalized-store option and when it is the right
trade: [`docs/architecture/external-state.md`](architecture/external-state.md).

---

## Islands — partial hydration as a runtime primitive

Mark islands in your server HTML and declare *when* each should activate:

```html
<div data-sibu-island="counter">…server HTML…</div>
<div data-sibu-island="chart" data-sibu-load="visible">…</div>
<div data-sibu-island="filters" data-sibu-load="interaction">…</div>
```

Register each island's setup and call `mountIslands()` once:

```ts
import { registerIsland, mountIslands, lazyIsland, signal } from "sibujs";

registerIsland("counter", (ctx) => {
  const [n, setN] = signal(0);
  ctx.text("@n", () => n());
  ctx.on("@inc", "click", () => setN((v) => v + 1));
});

// Lazy code — the module is fetched only when the island activates, so the page
// ships ~0 JS for islands that never trigger.
registerIsland("chart", lazyIsland(() => import("./islands/chart.js")));

mountIslands(); // wires the whole page, honoring each island's strategy
```

`mountIslands(root?, options?)` returns a cleanup function that cancels pending
schedulers and disposes every mounted island.

Cleanup releases the markup, so **the same DOM can be mounted again** — each
island activates a fresh generation with a single set of bindings. Calling
`mountIslands()` twice *without* cleaning up in between is safe too: islands
that are already active are skipped rather than double-wired.

An island whose setup throws is reported to the console and isolated — its
siblings still activate, and the failed island leaves no bindings or listeners
behind, so it can be mounted again once its setup is fixed.

### Activation strategies (`data-sibu-load`)

| Strategy | Activates… | Notes |
| --- | --- | --- |
| `load` *(default)* | immediately (next microtask) | |
| `idle` | on `requestIdleCallback` | falls back to a timeout |
| `visible` | when the element scrolls into view | `IntersectionObserver`; eager fallback where unavailable |
| `interaction` | on first pointer / focus / key / touch | cheapest until the user engages |
| `media` | when `data-sibu-media` matches | e.g. `data-sibu-media="(min-width: 768px)"` |

### Cleanup checklist

Anything the setup opens, the setup must close, through `ctx.cleanup()`:

```ts
registerIsland("clock", (ctx) => {
  const timer = setInterval(tick, 1000);
  ctx.cleanup(() => clearInterval(timer));

  const socket = new WebSocket(url);
  ctx.cleanup(() => socket.close());

  const observer = new ResizeObserver(onResize);
  observer.observe(ctx.root);
  ctx.cleanup(() => observer.disconnect());

  const region = mount(() => Panel(), ctx.ref("@panel"));
  ctx.cleanup(region.unmount);
});
```

Bindings and `ctx.on` listeners need no registration — they are already owned. A
cleanup that throws is reported and the remaining cleanups still run.

---

## Accessible conditional UI

A modal inside an enhanced island — a promotion picker, a confirmation, an
inline editor — is where "conditional rendering" stops being about DOM and
starts being about focus. The pattern that works:

1. **Server-render the dialog markup, hidden.** It is durable UI; there is no
   reason for the client to create it. `ctx.show()` reveals it.
2. **Let a `machine` own the state**, so "is it open" and "what happens next" have
   one source of truth and an invalid transition is a no-op rather than a
   double commit.
3. **Apply ARIA with `createDialogAria()`** (`sibujs/ui`), which generates the
   `aria-labelledby` / `aria-describedby` ids — so two instances of the same
   island on one page cannot collide on an `id`.
4. **Move focus in, contain it, and put it back** with `createFocusManager()`.
5. **Handle `Escape` on the dialog element**, not on `document`, so two instances
   never fight over the keyboard.

```ts
const flow = machine({
  initial: "idle",
  states: {
    idle: { on: { SELECT: "piece-selected" } },
    "piece-selected": { on: { PLAY: "move-committed", PROMOTE: "promotion-required", CLEAR: "idle" } },
    "promotion-required": { on: { CHOOSE: "promotion-selected", CANCEL: "piece-selected" } },
    "promotion-selected": { on: { COMMIT: "move-committed" } },
    "move-committed": { on: { DONE: "idle" } },
  },
});

const dialogEl = ctx.ref("@promotion");
const aria = createDialogAria(dialogEl, { modal: true });
titleEl.id = aria.titleId;
descEl.id = aria.descriptionId;
const focusManager = createFocusManager(dialogEl);

ctx.show(dialogEl, () => flow.matches("promotion-required"));
ctx.on(dialogEl, "keydown", (event) => { /* Escape → CANCEL; Tab → cycle */ });
```

**Committing exactly once is a property of the state, not of a flag.** After
`CHOOSE`, the machine is in `promotion-selected`, which has no `CHOOSE`
transition — a second click, or a click racing the keyboard, does nothing. No
`let committed = false` to remember to reset.

**`FocusTrap` vs `createFocusManager`.** `FocusTrap` (`sibujs/ui`) creates a
wrapper element around the nodes it traps, which suits mounted content. For
markup the server already rendered, `createFocusManager` reads the focusable
descendants of the element you give it and leaves the DOM alone — the right tool
on the enhanced side.

**`dialog()` (`sibujs/ui`)** owns open/close state plus an app-wide Escape stack.
It is the right choice when nothing else owns "is it open". When a `machine`
already does, using both means two sources of truth for one fact; pick one. The
chess example picks the machine, and says so in a comment.

**Reduced motion.** If the dialog animates, opt out:

```css
@media (prefers-reduced-motion: reduce) { .promotion { animation: none; } }
```

A complete, browser-tested implementation is in
[`examples/chess/chess-island.js`](../examples/chess/chess-island.js), exercised
by [`tests-browser/chess.spec.ts`](../tests-browser/chess.spec.ts) across
Chromium, Firefox and WebKit.

---

## Host-framework interoperability

An island lives happily inside a page owned by something else — a component
framework's server shell, Astro, Laravel, Django, Rails, WordPress, or plain
static HTML. The rules (who owns the root, when to mount, how to handle
client-side navigation, how to avoid double activation) are in
[`docs/interop.md`](interop.md), with two implementations verified in browsers.

The short version: the host renders the root and calls `mountIslands()` after
rendering; you keep the returned disposer and call it before the host replaces
the markup. That is the whole contract.

---

## Performance profiling

Before optimising, count. The most decisive measurement is how many bindings
actually ran:

```ts
let runs = 0;
ctx.each("@cell", (el, i) => ({
  text: () => { runs++; changed.track(); return engine.get(i); },
}));

const before = runs;
play(move);
console.log("bindings re-run:", runs - before);
```

64 for a two-cell change is a fan-out problem. 2 is not, and you should measure
something else.

- `npm run bench:islands-dx` — invalidation cost, `ctx.each` vs hand-written
  bindings, broad vs granular updates, enhance/dispose stability, and the bundle
  cost of each new primitive.
- `npm run bench:islands-size` — the gzipped size of the no-build islands runtime.
- `external({ name: "…" })` labels the source for `sibujs/devtools`.

More, including why there is no built-in effect-execution counter:
[`docs/architecture/external-state.md`](architecture/external-state.md#profiling-measuring-invalidation-fan-out).

---

## The chess reference application

[`examples/chess/`](../examples/chess/) is a complete chess game built as an
enhanced island. It demonstrates, in one file you can read top to bottom:

durable server-rendered board · `data-sibu-island` · `registerIsland` /
`mountIslands` · `@ref` targets · `ctx.each` over 64 squares · `external()`
invalidation · per-square signals for the hot path · a second invalidation
domain for the clock · an enhanced board plus a **mounted** move history ·
feature-local state · keyboard grid navigation · a live status region · undo ·
board flipping · captured pieces · check and last-move styling · an accessible
promotion dialog · timer cleanup · two independent boards on one page · a
deliberately broken island beside them.

`chess.js` provides the rules. SibuJS provides DOM enhancement, reactivity,
lifecycle and UI behaviour, and knows nothing about chess. `chess.js` is a
**devDependency and an example dependency only** — it is not reachable from any
package entry point and is not in the published tarball.

```bash
npm ci
npm run build                 # the package's own dist/
npm run example:chess:build   # vendors chess.js into examples/chess/vendor/
npm run example:serve         # → http://localhost:5099/examples/chess/
```

---

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The UI does not update after mutating a library object | SibuJS cannot see writes it does not own | Call `external().invalidate()` at the mutation site, and `track()` in the getters |
| A binding updated once and then froze | The value was read eagerly instead of in a getter: `ctx.text(el, value())` | Pass the function: `ctx.text(el, () => value())` |
| The second widget on the page misbehaves | State at module scope, shared by every instance | Create it inside the island setup |
| A timer/socket keeps running after navigation | The host replaced the markup without calling the disposer | Keep the disposer from `mountIslands()` and call it before the swap |
| Focus jumps to the top of the page when a region updates | A node holding focus was replaced | Use `enhance` (or `ctx.show`) for that region instead of re-rendering it |
| An enhanced element is ignored, with a dev warning | It is still owned by a live enhancement | Dispose the first one; the marker tracks current ownership |
| Content stays behind after unmounting a `when()` | `when` inserts its branch as a *sibling* of its anchor | Wrap it: `mount(() => div(when(...)), slot)` |
| Two `id`s collide across island instances | Ids written in server markup are duplicated per instance | Generate them at setup (`createId()`, `createDialogAria()`) |
| `ctx.each` throws about an unknown binding key | A typo in the descriptor (`txt`, `classes`, `attrs`) | The dev error names the index and key; the fields are `text`, `attr`, `class`, `show`, `on`, `cleanup` |
| A flash of the wrong value on activation | The first binding run disagreed with the server markup | Seed the signal with the value the server rendered |

---

## Architecture decision table

| Situation | Recommended approach |
| --- | --- |
| DOM already exists and must be retained | `enhance()` |
| Client must create a dynamic region | `mount()` |
| Durable shell with dynamic subregions | Combine `enhance()` and `mount()`, with `ctx.cleanup(unmount)` |
| Many existing elements needing the same bindings | `ctx.each()` |
| External mutable engine | `external()` — `track()` where you read, `invalidate()` where you mutate |
| Small fixed grid | Broad invalidation is sufficient |
| Large or frequently updated grid | Separate invalidation domains, or one signal per cell |
| Multiple widget instances | Feature-local state created inside the island setup |
| A page owned by another framework | An incremental island — see [`docs/interop.md`](interop.md) |
| A modal inside an enhanced island | Server-rendered markup + `machine` + `ctx.show()` + `createDialogAria` / `createFocusManager` |

---

## The zero-build golden path

No npm, no transpile — one HTML file:

```html
<div data-sibu-island="counter">
  <output data-ref="n">0</output>
  <button data-ref="inc">+1</button>
</div>

<script src="https://unpkg.com/sibujs@latest/dist/cdn.global.js"></script>
<script>
  const { signal, registerIsland, mountIslands } = window.Sibu;
  registerIsland("counter", (ctx) => {
    const [n, setN] = signal(0);
    ctx.text("@n", () => n());
    ctx.on("@inc", "click", () => setN((v) => v + 1));
  });
  mountIslands();
</script>
```

A complete, runnable version (multiple islands and strategies) lives in
[`examples/islands.html`](../examples/islands.html).

---

## From your backend

The pattern is identical no matter what emits the HTML — Rails/Hotwire, Django,
Laravel, Go templates, Hugo/Eleventy, PHP, or a CMS:

1. Render your page as usual.
2. Wrap the interactive bits in `data-sibu-island="name"` and tag the dynamic
   nodes with `data-ref="…"`.
3. Add the `<script>` tag, register the islands, call `mountIslands()`.

You adopt it **one widget at a time** — there's no app-wide migration, no router
to take over, and the rest of your server-rendered page is untouched.

---

## Embedding into pages you don't control

Because there's no build step, no global framework state to pollute, and the
runtime is small with built-in URL/HTML sanitization and prototype-pollution
guards, `enhance`/islands are a good fit for **third-party widgets** dropped into
a host page — a comment box, a pricing calculator, a status widget. Scope your
ids with `createId()` and your styles with the scoped-style helpers, and the
widget stays isolated from its host.
