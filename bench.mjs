#!/usr/bin/env node

/**
 * Sibu — Stress Test / Benchmark
 *
 * Measures performance of:
 *   1. Signal creation (signal)
 *   2. Signal read/write throughput
 *   3. Computed derivations (derived)
 *   4. Effect tracking (effect)
 *   5. Watcher propagation (watch)
 *   6. Batch updates
 *   7. DOM element creation (tagFactory)
 *   8. Reactive DOM updates (attribute binding)
 *   9. List rendering & diffing (each — LIS reconciliation)
 *  10. Deep dependency graph (diamond pattern)
 *
 * Run:  node bench.mjs
 */

import { JSDOM } from "jsdom";

// ── Bootstrap jsdom ──────────────────────────────────────────────────────────
//
// This script is standalone (run via `node bench.mjs`) so mutating globalThis
// here is safe. The installBenchGlobals/restoreBenchGlobals pair is exported
// shape for anyone importing this module from a test runner that cares about
// global cleanup. Note: queueMicrotask is already available natively in Node.

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");

const BENCH_GLOBAL_KEYS = ["document", "HTMLElement", "Element", "Node", "Comment"];
const _savedGlobals = {};

export function installBenchGlobals() {
  for (const key of BENCH_GLOBAL_KEYS) {
    _savedGlobals[key] = Object.prototype.hasOwnProperty.call(globalThis, key)
      ? globalThis[key]
      : undefined;
    globalThis[key] = dom.window[key];
  }
}

export function restoreBenchGlobals() {
  for (const key of BENCH_GLOBAL_KEYS) {
    if (_savedGlobals[key] === undefined) {
      delete globalThis[key];
    } else {
      globalThis[key] = _savedGlobals[key];
    }
  }
}

installBenchGlobals();

// ── Import Sibu (from source via tsup output) ────────────────────────────────

const {
  signal,
  effect,
  derived,
  watch,
  batch,
  div,
  span,
  button,
  ul,
  li,
  mount,
  each,
  html,
} = await import("./dist/index.js");


// ── Helpers ──────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function fmt(n) {
  return n.toLocaleString("en-US");
}

function fmtTime(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(2)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtOps(ops) {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M ops/s`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(2)}K ops/s`;
  return `${ops.toFixed(0)} ops/s`;
}

function runBench(name, fn, { iterations = 1, warmup = 0 } = {}) {
  // Warmup
  for (let i = 0; i < warmup; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const perOp = elapsed / iterations;
  const opsPerSec = (iterations / elapsed) * 1000;

  return { name, elapsed, iterations, perOp, opsPerSec };
}

function printResult(r) {
  const opsStr = r.iterations > 1 ? `  ${DIM}${fmtOps(r.opsPerSec)}${RESET}` : "";
  console.log(
    `  ${GREEN}✓${RESET} ${r.name.padEnd(44)} ${CYAN}${fmtTime(r.elapsed).padStart(10)}${RESET}` +
      `  ${DIM}(${fmt(r.iterations)} iters, ${fmtTime(r.perOp)}/op)${RESET}${opsStr}`
  );
}

function section(title) {
  console.log(`\n${BOLD}${YELLOW}── ${title} ${"─".repeat(58 - title.length)}${RESET}`);
}

// ── Benchmarks ───────────────────────────────────────────────────────────────

console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║              Sibu — Stress Test / Benchmark                     ║${RESET}`);
console.log(`${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}`);

const results = [];

// ─── 1. Signal creation ──────────────────────────────────────────────────────

section("1. Signal Creation (signal)");

const N_SIGNALS = 100_000;
results.push(
  runBench(`Create ${fmt(N_SIGNALS)} signals`, () => {
    for (let i = 0; i < N_SIGNALS; i++) signal(i);
  }, { iterations: 10, warmup: 2 })
);
printResult(results.at(-1));

// ─── 2. Signal read/write throughput ─────────────────────────────────────────

section("2. Signal Read / Write Throughput");

const N_RW = 500_000;
{
  const [get, set] = signal(0);
  results.push(
    runBench(`${fmt(N_RW)} reads`, () => {
      for (let i = 0; i < N_RW; i++) get();
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`${fmt(N_RW)} writes (no subscribers)`, () => {
      for (let i = 0; i < N_RW; i++) set(i);
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));
}

// ─── 3. Computed derivations ─────────────────────────────────────────────────

section("3. Computed Derivations (derived)");

{
  const N_COMPUTED = 10_000;
  const [get, set] = signal(1);

  results.push(
    runBench(`Create ${fmt(N_COMPUTED)} computed from 1 signal`, () => {
      for (let i = 0; i < N_COMPUTED; i++) derived(() => get() * 2);
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  // Chain of computed values
  const CHAIN_LEN = 1_000;
  const [cGet, cSet] = signal(0);
  let prev = cGet;
  for (let i = 0; i < CHAIN_LEN; i++) {
    const p = prev;
    prev = derived(() => p() + 1);
  }
  const chainEnd = prev;

  results.push(
    runBench(`Propagate through ${fmt(CHAIN_LEN)}-deep computed chain`, () => {
      for (let i = 0; i < 1000; i++) {
        cSet(i);
        chainEnd(); // force evaluation
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));
}

// ─── 4. Effect tracking ─────────────────────────────────────────────────────

section("4. Effect Tracking (effect)");

{
  const N_EFFECTS = 10_000;
  const [get, set] = signal(0);
  let effectCount = 0;

  const cleanups = [];
  results.push(
    runBench(`Create ${fmt(N_EFFECTS)} effects on 1 signal`, () => {
      for (let i = 0; i < N_EFFECTS; i++) {
        cleanups.push(effect(() => { get(); effectCount++; }));
      }
    }, { iterations: 1 })
  );
  printResult(results.at(-1));

  // Update signal → triggers all effects
  effectCount = 0;
  results.push(
    runBench(`Trigger ${fmt(N_EFFECTS)} effects (1 signal update)`, () => {
      set((v) => v + 1);
    }, { iterations: 100, warmup: 0 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(effectCount)} total effect runs)${RESET}`);

  // Cleanup
  for (const c of cleanups) c();
}

// ─── 5. Watcher propagation ─────────────────────────────────────────────────

section("5. Watcher Propagation (watch)");

{
  const N_WATCHERS = 5_000;
  const [get, set] = signal(0);
  let watchCount = 0;
  const teardowns = [];

  for (let i = 0; i < N_WATCHERS; i++) {
    teardowns.push(watch(get, () => { watchCount++; }));
  }

  results.push(
    runBench(`Notify ${fmt(N_WATCHERS)} watchers per update`, () => {
      set((v) => v + 1);
    }, { iterations: 200, warmup: 5 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(watchCount)} total watcher calls)${RESET}`);

  for (const t of teardowns) t();
}

// ─── 6. Batch updates ───────────────────────────────────────────────────────

section("6. Batch Updates");

{
  const N_BATCH = 1_000;
  const signals = [];
  for (let i = 0; i < N_BATCH; i++) signals.push(signal(0));

  let effectRuns = 0;
  const cleanup = effect(() => {
    for (const [get] of signals) get();
    effectRuns++;
  });

  // Without batch — each signal change triggers the effect separately
  effectRuns = 0;
  results.push(
    runBench(`${fmt(N_BATCH)} updates WITHOUT batch`, () => {
      for (let i = 0; i < N_BATCH; i++) signals[i][1]((v) => v + 1);
    }, { iterations: 10, warmup: 1 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(effectRuns)} effect runs)${RESET}`);

  // With batch — all updates coalesced, effect fires once per batch
  effectRuns = 0;
  results.push(
    runBench(`${fmt(N_BATCH)} updates WITH batch`, () => {
      batch(() => {
        for (let i = 0; i < N_BATCH; i++) signals[i][1]((v) => v + 1);
      });
    }, { iterations: 10, warmup: 1 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(effectRuns)} effect runs — expected 11: 1 warmup + 10 iters)${RESET}`);

  cleanup();
}

// ─── 7. DOM element creation ─────────────────────────────────────────────────

section("7. DOM Element Creation (tagFactory)");

{
  const N_ELEMENTS = 10_000;

  results.push(
    runBench(`Create ${fmt(N_ELEMENTS)} <div> elements (no props)`, () => {
      for (let i = 0; i < N_ELEMENTS; i++) div();
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`Create ${fmt(N_ELEMENTS)} <div> with props`, () => {
      for (let i = 0; i < N_ELEMENTS; i++) {
        div({
          id: `item-${i}`,
          class: "card active",
          style: { color: "red", fontSize: "14px" },
          "data-index": String(i),
        });
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`Create ${fmt(N_ELEMENTS)} nested trees (div > span + span)`, () => {
      for (let i = 0; i < N_ELEMENTS; i++) {
        div({ nodes: [span({ nodes: ["Hello"] }), span({ nodes: ["World"] })] });
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));
}

// ─── 7b. Three Authoring Styles Compared ────────────────────────────────────

section("7b. Three Authoring Styles Compared");

{
  const N = 10_000;

  // ── Test 1: Simple element (no props) ──

  console.log(`\n  ${DIM}── Simple <div> (no props) ──${RESET}`);

  results.push(
    runBench(`  props obj:  ${fmt(N)} <div>`, () => {
      for (let i = 0; i < N; i++) div({});
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  shorthand:  ${fmt(N)} <div>`, () => {
      for (let i = 0; i < N; i++) div();
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  html tmpl:  ${fmt(N)} <div>`, () => {
      for (let i = 0; i < N; i++) html`<div></div>`;
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  // ── Test 2: Element with class + text ──

  console.log(`\n  ${DIM}── <p> with class + text ──${RESET}`);

  results.push(
    runBench(`  props obj:  ${fmt(N)} <p class+text>`, () => {
      for (let i = 0; i < N; i++) {
        span({ class: "label", nodes: "Hello" });
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  shorthand:  ${fmt(N)} <p class+text>`, () => {
      for (let i = 0; i < N; i++) {
        span("label", "Hello");
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  html tmpl:  ${fmt(N)} <p class+text>`, () => {
      for (let i = 0; i < N; i++) {
        html`<span class="label">Hello</span>`;
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  // ── Test 3: Element with dynamic attributes ──

  console.log(`\n  ${DIM}── <div> with dynamic attrs ──${RESET}`);

  results.push(
    runBench(`  props obj:  ${fmt(N)} <div> dyn attrs`, () => {
      for (let i = 0; i < N; i++) {
        div({ id: `item-${i}`, class: "card active", "data-index": String(i) });
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  shorthand:  ${fmt(N)} <div> dyn attrs`, () => {
      for (let i = 0; i < N; i++) {
        div({ id: `item-${i}`, class: "card active", "data-index": String(i) });
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  html tmpl:  ${fmt(N)} <div> dyn attrs`, () => {
      for (let i = 0; i < N; i++) {
        html`<div id=${`item-${i}`} class="card active" data-index=${String(i)}></div>`;
      }
    }, { iterations: 10, warmup: 2 })
  );
  printResult(results.at(-1));

  // ── Test 4: Nested tree (div > span + span) ──

  console.log(`\n  ${DIM}── Nested tree (div > span + span) ──${RESET}`);

  results.push(
    runBench(`  props obj:  ${fmt(N)} nested`, () => {
      for (let i = 0; i < N; i++) {
        div({ nodes: [span({ nodes: "Hello" }), span({ nodes: "World" })] });
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  shorthand:  ${fmt(N)} nested`, () => {
      for (let i = 0; i < N; i++) {
        div([span("Hello"), span("World")]);
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  html tmpl:  ${fmt(N)} nested`, () => {
      for (let i = 0; i < N; i++) {
        html`<div><span>Hello</span><span>World</span></div>`;
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  // ── Test 5: Deep nesting (3 levels with event handler) ──

  console.log(`\n  ${DIM}── Deep nesting (div > div > button with event) ──${RESET}`);

  const handler = () => {};

  results.push(
    runBench(`  props obj:  ${fmt(N)} deep+event`, () => {
      for (let i = 0; i < N; i++) {
        div({ class: "card", nodes: [
          div({ class: "body", nodes: [
            span({ nodes: `Item ${i}` }),
            button({ nodes: "Click", class: "btn", on: { click: handler } }),
          ] }),
        ] });
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  shorthand:  ${fmt(N)} deep+event`, () => {
      for (let i = 0; i < N; i++) {
        div("card", [
          div("body", [
            span(`Item ${i}`),
            button({ nodes: "Click", class: "btn", on: { click: handler } }),
          ]),
        ]);
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  results.push(
    runBench(`  html tmpl:  ${fmt(N)} deep+event`, () => {
      for (let i = 0; i < N; i++) {
        html`<div class="card">
          <div class="body">
            <span>${`Item ${i}`}</span>
            <button class="btn" on:click=${handler}>Click</button>
          </div>
        </div>`;
      }
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));
}

// ─── 8. Reactive DOM updates ─────────────────────────────────────────────────

section("8. Reactive DOM Updates");

{
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [getText, setText] = signal("initial");
  const [getCls, setCls] = signal("off");

  const el = div({
    class: getCls,
    nodes: [() => getText()],
  });
  mount(el, container);

  // Flush microtasks for initial binding
  await new Promise((r) => setTimeout(r, 10));

  const N_UPDATES = 10_000;
  results.push(
    runBench(`${fmt(N_UPDATES)} reactive class updates`, () => {
      for (let i = 0; i < N_UPDATES; i++) setCls(i % 2 === 0 ? "on" : "off");
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));

  container.innerHTML = "";
}

// ─── 9. List rendering & diffing (each) ──────────────────────────────────────

section("9. List Rendering & Diffing (each)");

{
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [getItems, setItems] = signal(
    Array.from({ length: 1000 }, (_, i) => ({ id: i, label: `Item ${i}` }))
  );

  const list = ul({
    nodes: [
      each(
        getItems,
        (item) => li({ nodes: [item.label] }),
        { key: (item) => item.id }
      ),
    ],
  });

  mount(list, container);
  await new Promise((r) => setTimeout(r, 10));

  // Append items
  results.push(
    runBench("Append 1,000 items to 1,000-item list", () => {
      setItems((prev) => [
        ...prev.slice(0, 1000),
        ...Array.from({ length: 1000 }, (_, i) => ({
          id: 10000 + i + Math.random() * 100000,
          label: `New ${i}`,
        })),
      ]);
    }, { iterations: 50, warmup: 2 })
  );
  printResult(results.at(-1));

  // Reverse the list
  setItems(Array.from({ length: 1000 }, (_, i) => ({ id: i, label: `Item ${i}` })));
  await new Promise((r) => setTimeout(r, 10));

  results.push(
    runBench("Reverse 1,000-item list", () => {
      setItems((prev) => [...prev].reverse());
    }, { iterations: 100, warmup: 5 })
  );
  printResult(results.at(-1));

  // Remove every other item
  setItems(Array.from({ length: 2000 }, (_, i) => ({ id: i + 50000, label: `Item ${i}` })));
  await new Promise((r) => setTimeout(r, 10));

  results.push(
    runBench("Remove every 2nd item from 2,000-item list", () => {
      setItems((prev) => prev.filter((_, i) => i % 2 === 0));
    }, { iterations: 50, warmup: 2 })
  );
  printResult(results.at(-1));

  // Shuffle
  setItems(Array.from({ length: 1000 }, (_, i) => ({ id: i + 90000, label: `Item ${i}` })));
  await new Promise((r) => setTimeout(r, 10));

  results.push(
    runBench("Shuffle 1,000-item list (random reorder)", () => {
      setItems((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      });
    }, { iterations: 100, warmup: 5 })
  );
  printResult(results.at(-1));

  // Clear the entire list
  setItems(Array.from({ length: 5000 }, (_, i) => ({ id: i + 200000, label: `Item ${i}` })));
  await new Promise((r) => setTimeout(r, 10));

  results.push(
    runBench("Clear 5,000-item list", () => {
      setItems([]);
    }, { iterations: 50, warmup: 2 })
  );
  printResult(results.at(-1));

  container.innerHTML = "";
}

// ─── 10. Deep diamond dependency graph ───────────────────────────────────────

section("10. Deep Diamond Dependency Graph");

{
  //    [A]
  //   /   \
  // [B]   [C]
  //   \   /
  //    [D]  ← should update once per A change

  const [getA, setA] = signal(0);
  const getB = derived(() => getA() + 1);
  const getC = derived(() => getA() * 2);
  const getD = derived(() => getB() + getC());

  let dUpdates = 0;
  const cleanup = effect(() => {
    getD();
    dUpdates++;
  });

  dUpdates = 0;
  results.push(
    runBench("Diamond graph: 10,000 root updates", () => {
      for (let i = 0; i < 10_000; i++) setA(i);
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(dUpdates)} D-effect runs for ${fmt(50_000)} A updates)${RESET}`);

  // Wide diamond: N leaves depending on 1 root, 1 aggregator depending on all
  const WIDTH = 500;
  const [rootGet, rootSet] = signal(0);
  const leaves = [];
  for (let i = 0; i < WIDTH; i++) {
    leaves.push(derived(() => rootGet() + i));
  }
  const aggregator = derived(() => {
    let sum = 0;
    for (const l of leaves) sum += l();
    return sum;
  });

  let aggUpdates = 0;
  const cleanup2 = effect(() => {
    aggregator();
    aggUpdates++;
  });

  aggUpdates = 0;
  results.push(
    runBench(`Wide diamond (${WIDTH} branches): 1,000 root updates`, () => {
      for (let i = 0; i < 1_000; i++) rootSet(i);
    }, { iterations: 5, warmup: 1 })
  );
  printResult(results.at(-1));
  console.log(`    ${DIM}(${fmt(aggUpdates)} aggregator runs)${RESET}`);

  cleanup();
  cleanup2();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}${YELLOW}── Summary ${"─".repeat(54)}${RESET}`);
const totalMs = results.reduce((s, r) => s + r.elapsed, 0);
console.log(`  Total: ${CYAN}${fmtTime(totalMs)}${RESET}  (${results.length} benchmarks)\n`);

// ─── JSON output & baseline comparison ───────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASELINE_FILE = "bench-baseline.json";
const jsonFlag = process.argv.includes("--json");
const saveFlag = process.argv.includes("--save");
const compareFlag = process.argv.includes("--compare");

const jsonResults = results.map(r => ({
  name: r.name.trim(),
  elapsed: Math.round(r.elapsed * 100) / 100,
  iterations: r.iterations,
  perOp: Math.round(r.perOp * 1000) / 1000,
  opsPerSec: Math.round(r.opsPerSec),
}));

if (jsonFlag) {
  console.log(JSON.stringify(jsonResults, null, 2));
}

if (saveFlag) {
  writeFileSync(BASELINE_FILE, JSON.stringify(jsonResults, null, 2));
  console.log(`${GREEN}✓${RESET} Baseline saved to ${BASELINE_FILE}`);
}

if (compareFlag && existsSync(BASELINE_FILE)) {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  const RED = "\x1b[31m";

  console.log(`\n${BOLD}${YELLOW}── Regression Check ${"─".repeat(45)}${RESET}`);

  let regressions = 0;
  for (const current of jsonResults) {
    const base = baseline.find(b => b.name === current.name);
    if (!base) continue;

    const ratio = current.perOp / base.perOp;
    const pctChange = ((ratio - 1) * 100).toFixed(1);

    if (ratio > 1.2) {
      // >20% slower = regression
      console.log(`  ${RED}✗${RESET} ${current.name.padEnd(44)} ${RED}+${pctChange}% slower${RESET}  (${fmtTime(base.perOp)} → ${fmtTime(current.perOp)})`);
      regressions++;
    } else if (ratio < 0.8) {
      // >20% faster = improvement
      console.log(`  ${GREEN}↑${RESET} ${current.name.padEnd(44)} ${GREEN}${pctChange}% faster${RESET}`);
    } else {
      console.log(`  ${DIM}≈ ${current.name.padEnd(44)} ${pctChange}%${RESET}`);
    }
  }

  if (regressions > 0) {
    console.log(`\n  ${RED}${BOLD}${regressions} regression(s) detected!${RESET} (>20% slower than baseline)\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n  ${GREEN}${BOLD}No regressions detected.${RESET}\n`);
  }
} else if (compareFlag) {
  console.log(`\n${YELLOW}No baseline found.${RESET} Run with --save first to create one.\n`);
}
