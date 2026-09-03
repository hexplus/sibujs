# External mutable state, invalidation domains, and update granularity

SibuJS tracks reads of **its own** signals. A chess engine, a canvas scene
graph, a CodeMirror document, a media element, a cache a WebSocket writes into —
all of these keep their state in objects the runtime never sees written.

This document is about the seam between those two worlds: the primitive that
connects them, the four state architectures you can build on it, and how to tell
which one a feature actually needs.

---

## Why there is no automatic answer

A framework can only observe what it owns. Making arbitrary third-party mutation
observable would require one of:

| Approach | Why SibuJS does not do it |
| --- | --- |
| Wrap the object in a `Proxy` | Breaks `instanceof`, private fields, and any internal `this` identity check. A `Chess` instance behind a proxy is no longer the object its own methods were written against. |
| Deep-clone and diff | Turns every read into a structural comparison, and doubles memory for state you did not want to own. |
| Patch the library's methods | Silently breaks on the next version, and cannot see writes that do not go through a method. |
| Poll | Wrong answers between polls; wasted work when nothing changed. |

So SibuJS does the honest thing: it gives you a **valueless reactive token** and
asks you to say when the outside world changed.

```ts
import { external } from "sibujs";

const game = new Chess();     // owns the rules and the mutable state
const moved = external();     // owns "something changed"

ctx.text("@status", () => {
  moved.track();              // this binding reads the engine
  return game.isCheckmate() ? "Checkmate" : `${game.turn()} to move`;
});

game.move({ from: "e2", to: "e4" });
moved.invalidate();           // every consumer above re-reads
```

`track()` and `invalidate()` are deliberately two calls, because the two things
they represent genuinely happen in different places: a getter reads, a command
handler mutates. Anything that collapses them has to guess.

### What `external()` guarantees

- It never proxies, clones or inspects your object. It has no reference to it.
- `invalidate()` is a signal write: it participates in `batch()`, so a burst of
  mutations inside one batch notifies consumers once.
- It works anywhere a signal read works — bindings, `effect()`, `derived()`.
- Consumers keep their own ownership. A disposed effect, a disposed binding or a
  disposed island is **never** invalidated.
- A consumer that throws is reported through the ordinary runtime error pipeline
  with its own phase and node — a binding stays a `"binding"` with its element,
  an effect stays an `"effect"`.
- It costs about 60 bytes gzipped on top of `signal` + `effect`.

### What it does not do

It does not make your engine reactive. If you mutate and forget to
`invalidate()`, the UI is stale — and that is a bug in your code that no
framework can find for you. The one place this bites in practice is a library
that mutates **asynchronously on its own** (a socket pushing frames, a media
element firing `timeupdate`): subscribe to whatever event it exposes and call
`invalidate()` from there.

---

## The four architectures

Every interactive grid, editor, dashboard or media tool ends up choosing between
these. They compose — a real feature usually uses two.

### 1. One invalidation domain for the whole engine

```ts
const engine = new Whatever();
const changed = external();

// every consumer starts with changed.track()
```

| | |
| --- | --- |
| Complexity | Lowest. One line at each mutation site. |
| Runtime cost | Every consumer re-runs on every change. |
| Memory | One reactive source. |
| Granularity | None — all or nothing. |
| Integration effort | Minutes. |

**Reach for it first.** It is correct by construction: there is exactly one place
that can forget to publish a change, and forgetting is loud (nothing updates).

### 2. Several invalidation domains

```ts
const position = external();   // where the pieces are
const clock    = external();   // the timer, ticking every second
const chat     = external();   // messages arriving over a socket
```

| | |
| --- | --- |
| Complexity | Low. You now have to know which domain a mutation belongs to. |
| Runtime cost | Only the consumers of the affected domain re-run. |
| Memory | One source per domain. |
| Granularity | Per subsystem. |
| Integration effort | Small. |

**The highest-value refactor of the four**, because it is usually driven by a
real structural fact rather than by a micro-benchmark: a clock that ticks once a
second has no business re-running 64 board bindings. Split when two parts of the
engine change at genuinely different *rates*, not when one part is merely big.

### 3. One signal per cell

```ts
const cells = new Map(SQUARES.map((sq) => [sq, signal("")]));

// a move writes only the squares it touched
batch(() => {
  cells.get(from)[1]("");
  cells.get(to)[1]("P");
});
```

| | |
| --- | --- |
| Complexity | Medium. Something must now compute *which* cells changed. |
| Runtime cost | Only the changed cells re-run. Writing an unchanged value costs a comparison and notifies nobody. |
| Memory | One signal (~100 bytes) per cell. |
| Granularity | Per cell. |
| Integration effort | Moderate — you are mirroring engine state, and mirrors go stale. |

**Reach for it on the hot path, not the whole feature.** In the chess reference
this is used for *highlighting* (which changes on every click) and not for piece
glyphs (which change on every move — far less often).

The trick that makes it cheap: recompute the whole map and write every cell.
Signal equality turns unchanged writes into no-ops, so "write all 64" costs 64
comparisons and wakes only the two bindings that actually changed. You get
granularity without having to work out the diff yourself.

### 4. A normalized store mirroring the engine

```ts
const [board, { setState }] = store({ pieces: {...}, turn: "w", history: [] });
```

| | |
| --- | --- |
| Complexity | Highest. Two models of the same truth, kept in step by hand. |
| Runtime cost | Per-key granularity, plus the cost of maintaining the mirror. |
| Memory | A full second copy of the state. |
| Granularity | Per key. |
| Integration effort | Large, and permanent — every engine feature must be mirrored. |

**Usually the wrong trade for a domain engine you did not write.** It is right
when the engine is a *source* rather than the owner: data arriving over a socket,
a document you are editing locally, anything where SibuJS state is the real
state and the external system is an input or an output. If the external library
owns the truth, mirroring it means two truths.

---

## Measured, on a 64-square board

From `npm run bench:islands-dx` (Node 24.19.0, win32, jsdom — your numbers will
differ; the ratio is the point):

```
broad:    1 invalidation → 64 binding re-runs     15.92 µs/move
granular: 2 signal writes → 2 binding re-runs      4.69 µs/move
                                                  ~3.4× faster
```

Read that carefully before optimising anything. The "slow" architecture costs
**16 microseconds per move** — about 0.1% of a 16 ms frame. For a 64-cell grid,
broad invalidation is not a performance problem; it is a perfectly good default,
and choosing it costs you nothing you would ever see.

The picture changes with scale and rate, and both matter:

| Cells | Updates per second | Reasonable choice |
| --- | --- | --- |
| ≤ 100 | any | Broad invalidation (1) |
| ≤ 100 | but one subsystem ticks independently | Split domains (2) |
| 100 – 5 000 | on interaction (clicks, keys) | Per-cell signals (3) for the interactive layer |
| 100 – 5 000 | on a stream / animation frame | Per-cell signals (3), plus batching per frame |
| > 5 000 | any | Per-cell signals, and virtualize — do not bind cells you are not showing |

The rule of thumb that survives contact with real applications: **granularity
follows update FREQUENCY, not collection SIZE.** A 400-cell spreadsheet that
recalculates on blur is fine with broad invalidation. A 64-cell board that
repaints on `pointermove` is not.

---

## Profiling: measuring invalidation fan-out

Before optimising, measure. Two techniques, no framework support required.

### Count binding executions

The cheapest and most decisive measurement — how many bindings actually ran:

```ts
let runs = 0;
ctx.each("@cell", (el, i) => ({
  text: () => {
    runs++;                     // remove once you have your answer
    changed.track();
    return engine.get(i);
  },
}));

// then, around one interaction:
const before = runs;
play(move);
console.log("bindings re-run:", runs - before);
```

If that number is 64 for a two-square change, you have found your fan-out. If it
is 2, granularity is not your problem and you should measure something else.

### Time the update, not the framework

```ts
performance.mark("move:start");
game.move(m);
changed.invalidate();           // synchronous: bindings have run by the next line
performance.mark("move:end");
performance.measure("move", "move:start", "move:end");
```

Invalidation is synchronous outside a `batch()`, so the measure covers the DOM
writes too. Inside a `batch()`, put the end mark after the batch returns.

### The tools that are already there

- **`npm run bench:islands-dx`** — the benchmark the numbers above come from.
  Copy it and swap in your own grid; it is 200 lines with no harness.
- **`sibujs/devtools`** — `external({ name: "chess:position" })` labels the
  source, and the devtools hook receives `signal:create` / `signal:update`
  events for it like any other signal, so an invalidation storm is visible by
  name.
- **Chrome DevTools performance panel** — a broad invalidation is one
  synchronous task. If it does not show up in a profile, it is not your problem.

There is deliberately **no built-in "count effect executions" API**. It would
have to live on the hot path of every subscriber to be accurate, and the six
lines above answer the same question with zero production cost. The devtools
package already carries the general-purpose hooks for anything more.

---

## Generalising away from chess

| Domain | Natural invalidation domains |
| --- | --- |
| Spreadsheet / data grid | The sheet's cell store; selection; the formula-engine recalculation pass |
| Code editor | Document text; decorations/diagnostics; cursor & selection |
| Dashboard | Each data source; the time range; layout/edit mode |
| Diagram editor | Graph topology; per-node geometry; viewport/zoom |
| Card game | The deck/engine; the local player's hand; the animation clock |
| Media tool | The media element's time (`timeupdate`); the waveform/analysis buffer; transport state |

In every row, the split is by **who writes and how often**, not by what the data
is about. Selection and viewport change on pointer input; documents change on
edit; streams change on their own schedule. Give each rate its own source.

---

## See also

- [`docs/islands.md`](../islands.md) — `enhance()` vs `mount()`, `ctx.each`, and
  the chess reference.
- [`examples/chess/chess-island.js`](../../examples/chess/chess-island.js) — all
  three of the first architectures in one file, labelled.
