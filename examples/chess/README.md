# Chess — the SibuJS islands reference application

A complete chess game built as an **enhanced island**: the 64 squares are server
HTML, SibuJS attaches bindings to them, and no square is ever rebuilt.

```bash
npm ci
npm run build                 # the package's own dist/ (the example imports it directly)
npm run example:chess:build   # vendors chess.js into ./vendor/chess.js
npm run example:serve         # → http://localhost:5099/examples/chess/
```

`npm run example:chess:build` is only needed once, or after bumping `chess.js` —
`vendor/chess.js` is committed so a fresh clone can serve the example with just
a `npm run build`.

---

## The boundary this example exists to show

```
chess.js   owns the rules and the mutable game state
SibuJS     owns DOM enhancement, reactivity, lifecycle and UI behaviour
```

SibuJS knows nothing about chess. It cannot see a write into the `Chess`
instance and does not try to: [`external()`](../../docs/architecture/external-state.md)
is the seam — `track()` where a binding reads the engine, `invalidate()` where
the engine was mutated.

`chess.js` is a **devDependency of this package and a dependency of this
example**. It is not imported from `src/`, not reachable from any package entry
point, and not in the published tarball.

---

## Files

| File | |
| --- | --- |
| `index.html` | Server-style markup. Two boards, 64 `<button>` squares each, written out literally the way a server template would emit them. Also a deliberately broken island, to show failure isolation. |
| `chess-island.js` | The whole application. Plain ES module, no build step — read it top to bottom. |
| `chess.css` | Presentation only. Every highlight is a rule matching one `data-marks` attribute. |
| `vendor/chess.js` | The rules engine, bundled by `scripts/build-example-chess.mjs`. Generated; do not edit. |

---

## What it demonstrates

**Islands & enhancement** — `data-sibu-island`, `registerIsland()`,
`mountIslands()`, `@ref` targets, the `EnhanceContext`, `ctx.each` over 64
squares, and an enhanced board beside a **mounted** move-history region tied to
the same lifecycle.

**Three state architectures, side by side and labelled:**

| | Used for | Why |
| --- | --- | --- |
| One `external()` for the engine | Piece glyphs, status, history, captures | Changes once per move. Simple, and ~16 µs for 64 cells. |
| One `signal` per square | Selection / legal-target / last-move / check highlighting | Changes on every *click*. Writing all 64 marks wakes only the two that changed. |
| A second `external()` domain | The clock | Ticks every second and touches exactly one binding. The board never hears about it. |

**Interaction & accessibility** — roving-tabindex keyboard grid navigation
(arrows, Home/End, Enter/Space via real `<button>`s), a `role="status"` live
region, an accessible promotion dialog with a `machine`-owned flow, focus entry,
Tab containment, Escape cancellation, focus restoration, and a
`prefers-reduced-motion` opt-out.

**Lifecycle** — a `setInterval` clock released through `ctx.cleanup()`, a nested
`mount()` unmounted with the island, two fully independent boards on one page,
and a neighbouring island that throws on purpose without disturbing either.

---

## Things worth noticing while reading

- **`setupChess(ctx)` takes one argument.** The enhanced element is `ctx.root`.
- **All feature state is created inside the setup**, which is the entire reason
  two boards work with no code that knows there are two.
- **`ctx.show()` for the dialog, `when()` for the history.** `show` toggles a node
  that already exists; `when` creates and destroys nodes. Which one is right
  follows from which side of the enhance/mount boundary you are on.
- **`when()` is wrapped in a `div`.** It inserts its branch as a *sibling* of its
  anchor, so the mount needs to own an element that contains both — otherwise
  unmounting leaves the branch behind.
- **The promotion move cannot be committed twice**, and there is no boolean
  guarding it: after `CHOOSE` the machine is in a state with no `CHOOSE`
  transition.
- **Dialog ids are generated, not written in the HTML.** Two boards on one page
  would otherwise share an `aria-labelledby` target.

---

## Tested by

- [`tests-browser/chess.spec.ts`](../../tests-browser/chess.spec.ts) — 13 tests
  in Chromium, Firefox and WebKit: mouse and keyboard play, node identity across
  moves, focus preservation during reactive updates, live-region semantics,
  promotion focus/Tab/Escape/restoration, dynamic history rows, board isolation,
  failure isolation, disposal, and remounting after a host navigation.
- [`tests/example-chess-smoke.test.ts`](../../tests/example-chess-smoke.test.ts) —
  serves the built example and walks its whole module graph, so a missing entry
  or an unservable directory URL fails as a test rather than as a blank page.
