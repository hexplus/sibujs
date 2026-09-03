// ---------------------------------------------------------------------------
// Islands / enhancement DX benchmark.
//
//   node bench/islands-dx.mjs        (npm run bench:islands-dx)
//
// Measures the cost of the things this pass added, and the cost of the state
// architectures the docs recommend choosing between, on a real 64-square board:
//
//   1. external() invalidation vs a plain signal write
//   2. binding 64 elements with ctx.each vs the equivalent ctx.* calls
//   3. broad invalidation (whole engine) vs granular per-square signals
//   4. enhance → dispose stability over many cycles
//   5. the bundle cost of each new public primitive
//
// It reports what it measured. There is no baseline file and no pass/fail: the
// numbers are only meaningful next to the environment printed at the top.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
for (const key of ["document", "HTMLElement", "Element", "Node", "Comment", "Event", "KeyboardEvent"]) {
  globalThis[key] = dom.window[key];
}

const { signal, effect, batch, enhance, external } = await import("../dist/index.js");

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const SQUARES = RANKS.flatMap((r) => FILES.map((f) => `${f}${r}`));

function makeBoard() {
  const root_ = document.createElement("section");
  root_.innerHTML = SQUARES.map(
    (sq) => `<button data-ref="square" data-square="${sq}"><span data-ref="piece"></span></button>`,
  ).join("");
  document.body.appendChild(root_);
  return root_;
}

function time(label, iterations, fn, { warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;
  const perOp = elapsed / iterations;
  const unit = perOp < 0.001 ? `${(perOp * 1e6).toFixed(0)} ns` : `${(perOp * 1000).toFixed(2)} µs`;
  console.log(`  ${label.padEnd(52)} ${unit.padStart(12)}/op   ${elapsed.toFixed(1).padStart(8)} ms total`);
  return perOp;
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 64 - title.length))}`);
}

console.log("SibuJS — islands / enhancement DX benchmark");
console.log(`node ${process.version} · ${process.platform} · jsdom`);
console.log(
  `NODE_ENV=${process.env.NODE_ENV ?? "(unset → dev)"} — dev mode also runs ctx.each's descriptor validation, ` +
    "which a production browser bundle drops. Run with NODE_ENV=production for the shipped cost.",
);

// --- 1. invalidation cost ---------------------------------------------------

section("1. external() invalidation vs a plain signal write");
{
  const CONSUMERS = 64;

  const [n, setN] = signal(0);
  const src = external();
  let sink = 0;
  for (let i = 0; i < CONSUMERS; i++) {
    effect(() => {
      n();
      sink++;
    });
    effect(() => {
      src.track();
      sink++;
    });
  }

  let v = 0;
  time(`signal write → ${CONSUMERS} effects`, 20_000, () => setN(++v));
  time(`external.invalidate() → ${CONSUMERS} effects`, 20_000, () => src.invalidate());
  time("external.invalidate() with no consumers", 200_000, () => external().invalidate());
  console.log(`  (sink=${sink}, kept so nothing is optimised away)`);
}

// --- 2. ctx.each vs hand-written ctx.* calls --------------------------------

section("2. Binding 64 squares: ctx.each vs the equivalent ctx.* calls");
{
  const [selected, setSelected] = signal(null);
  const marks = new Map(SQUARES.map((sq) => [sq, signal("")]));

  // The board is created ONCE and re-enhanced, so the measurement is the
  // binding work — not jsdom's innerHTML parser, which would otherwise dominate
  // and hide the very difference being measured. A disposed root is
  // enhanceable again, which is what makes this legal.
  const boardA = makeBoard();
  const boardB = makeBoard();

  const imperative = () => {
    enhance(boardA, (ctx) => {
      for (const el of ctx.refs("@square")) {
        const sq = el.dataset.square;
        const [mark] = marks.get(sq);
        ctx.attr(el, "data-marks", () => mark());
        ctx.attr(el, "aria-selected", () => selected() === sq);
        ctx.classed(el, "sel", () => selected() === sq);
        ctx.on(el, "click", () => setSelected(sq));
      }
    })();
  };

  const declarative = () => {
    enhance(boardB, (ctx) => {
      ctx.each("@square", (el) => {
        const sq = el.dataset.square;
        const [mark] = marks.get(sq);
        return {
          attr: { "data-marks": () => mark(), "aria-selected": () => selected() === sq },
          class: { sel: () => selected() === sq },
          on: { click: () => setSelected(sq) },
        };
      });
    })();
  };

  const a = time("64 squares × 4 bindings — direct ctx.* calls", 2000, imperative);
  const b = time("64 squares × 4 bindings — ctx.each", 2000, declarative);
  const delta = ((b - a) / a) * 100;
  console.log(`  ctx.each vs hand-written: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%  (setup only; re-runs go through the same bindings)`);
  boardA.remove();
  boardB.remove();
}

// --- 3. broad vs granular ---------------------------------------------------

section("3. One move: broad invalidation vs per-square signals");
{
  // Broad: every square's glyph binding reads the engine through one source.
  const boardBroad = makeBoard();
  const engine = new Map(SQUARES.map((sq) => [sq, ""]));
  const position = external();
  let broadRuns = 0;
  enhance(boardBroad, (ctx) => {
    ctx.each("@piece", (el, i) => ({
      text: () => {
        position.track();
        broadRuns++;
        return engine.get(SQUARES[i]);
      },
    }));
  });

  // Granular: one signal per square; a move writes only the squares it touched.
  const boardFine = makeBoard();
  const cells = new Map(SQUARES.map((sq) => [sq, signal("")]));
  let fineRuns = 0;
  enhance(boardFine, (ctx) => {
    ctx.each("@piece", (el, i) => {
      const [value] = cells.get(SQUARES[i]);
      return {
        text: () => {
          fineRuns++;
          return value();
        },
      };
    });
  });

  let step = 0;
  const broadMove = () => {
    const from = SQUARES[step % 64];
    const to = SQUARES[(step + 8) % 64];
    step++;
    engine.set(from, "");
    engine.set(to, "P");
    position.invalidate();
  };

  let step2 = 0;
  const fineMove = () => {
    const from = SQUARES[step2 % 64];
    const to = SQUARES[(step2 + 8) % 64];
    step2++;
    batch(() => {
      cells.get(from)[1]("");
      cells.get(to)[1]("P");
    });
  };

  const before = { broadRuns, fineRuns };
  const broad = time("broad: 1 invalidation → 64 binding re-runs", 20_000, broadMove);
  const fine = time("granular: 2 signal writes → 2 binding re-runs", 20_000, fineMove);
  console.log(
    `  binding executions per move — broad: ${((broadRuns - before.broadRuns) / 20_003).toFixed(1)}` +
      `, granular: ${((fineRuns - before.fineRuns) / 20_003).toFixed(1)}`,
  );
  console.log(`  granular is ${(broad / fine).toFixed(1)}× faster per move at 64 cells`);
  console.log("  → for 64 cells both are far under one frame; see docs/architecture/external-state.md");
}

// --- 4. mount/dispose stability ---------------------------------------------

section("4. enhance → mutate → dispose stability");
{
  const cycles = 2000;
  const src = external();
  const rootsBefore = document.querySelectorAll("[data-sibu-enhanced]").length;
  const board = makeBoard();
  const start = performance.now();
  for (let i = 0; i < cycles; i++) {
    const stop = enhance(board, (ctx) => {
      ctx.each("@square", (el) => ({
        attr: { "data-i": () => { src.track(); return String(i); } },
        on: { click: () => {} },
      }));
    });
    src.invalidate();
    stop();
  }
  const elapsed = performance.now() - start;
  const rootsAfter = document.querySelectorAll("[data-sibu-enhanced]").length;
  board.remove();
  console.log(`  ${cycles} cycles of (enhance 64 squares → invalidate → dispose) on ONE board`);
  console.log(`  ${(elapsed / cycles).toFixed(3)} ms/cycle`);
  console.log(`  enhanced roots leaked by this section: ${rootsAfter - rootsBefore} (must be 0)`);
  console.log("  (heap is deliberately not reported: without a forced GC the number says nothing)");
}

// --- 5. bundle cost ---------------------------------------------------------

section("5. Bundle cost of each new primitive (minified + gzipped)");
{
  const bundle = async (entry) => {
    const result = await build({
      stdin: { contents: entry, resolveDir: root, loader: "ts" },
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2020",
      write: false,
      define: { __SIBU_DEV__: "false", __SIBU_VERSION__: '"bench"' },
    });
    const code = result.outputFiles[0].contents;
    return { min: code.length, gz: gzipSync(code).length };
  };

  const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
  const rows = [
    ["signal + effect (external lives here)", `export { signal, external } from "./src/core/signals/signal";
      export { effect } from "./src/core/signals/effect";`],
    ["signal + effect, external unused", `export { signal } from "./src/core/signals/signal";
      export { effect } from "./src/core/signals/effect";`],
    ["enhance + islands (includes ctx.each)", `export { signal, external } from "./src/core/signals/signal";
      export { effect } from "./src/core/signals/effect";
      export { enhance } from "./src/platform/enhance";
      export { registerIsland, mountIslands } from "./src/platform/islands";`],
  ];

  const sizes = [];
  for (const [label, entry] of rows) {
    const { min, gz } = await bundle(entry);
    sizes.push(gz);
    console.log(`  ${label.padEnd(40)} ${kb(min).padStart(10)} min   ${kb(gz).padStart(10)} gz`);
  }
  console.log(`  external() itself: ${kb(sizes[0] - sizes[1])} gz`);
  console.log("  note: `each` is part of the enhance module, so it is included in the enhance row.");

  // The property that matters to a consumer: importing `external` from the
  // PACKAGE ROOT must not drag the island runtime in. It used to, because a
  // module reachable only from the root entry lands in the index-only chunk.
  const distProbe = await build({
    stdin: {
      contents: [
        'import { external, signal } from "./dist/index.js";',
        "const s = external(); s.track(); s.invalidate();",
        "const [n] = signal(0); console.log(n());",
      ].join("\n"),
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  }).then((r) => r.outputFiles[0].text);
  console.log(
    `  from the packaged root, external + signal bundles to ${kb(distProbe.length)} ` +
      `(island runtime present: ${distProbe.includes("sibujs.islands.registry.v1")})`,
  );
}

console.log("");
