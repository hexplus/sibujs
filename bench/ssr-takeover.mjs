// HTML size and browser takeover time for the fixture landing page.
//
//   node bench/ssr-takeover.mjs [iterations=200]
//
// HTML size: the body markup of `/` with `renderToString`'s historical marker
// (`data-sibu-ssr` on every element), with the async renderers' default (root
// only), and with adoption markers (`hydration: "adopt"`), raw and gzip.
// Takeover: jsdom (the "browser"), the transferred state restored, the router
// ready; then `hydrate()` replace vs `hydrate(…, { strategy: "adopt" })`, timed
// until the page is live. Medians over N runs after a warm-up.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "node_modules", ".cache", "sibu-bench");
const runs = Number(process.argv[2] ?? 200);
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "ssr-takeover.entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(out, "ssr-takeover.entry.mjs"),
  define: { __SIBU_DEV__: "false" },
  logLevel: "error",
});

const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://fixture.test/" });
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis && !["Event", "EventTarget", "CustomEvent"].includes(key)) continue;
  try {
    globalThis[key] = window[key];
  } catch {}
}
globalThis.window = window;
globalThis.document = window.document;
window.HTMLCanvasElement.prototype.getContext = () => null;

const entry = await import(pathToFileURL(join(out, "ssr-takeover.entry.mjs")).href);
const modes = await entry.renderModes();

const size = (s) => ({ raw: Buffer.byteLength(s), gzip: gzipSync(s, { level: 9 }).length });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log("\nFixture landing page `/`, body markup\n");
console.log("| output | raw | gzip |");
console.log("|---|---|---|");
for (const [label, html] of [
  ["`renderToString` marker on every element", modes.legacy],
  ["async default (root marker only)", modes.plain],
  ['`hydration: "adopt"` markers', modes.adopt],
]) {
  const s = size(html);
  console.log(`| ${label} | ${s.raw} B | ${s.gzip} B |`);
}
console.log(`| transfer script | ${size(modes.state).raw} B | ${size(modes.state).gzip} B |`);

for (let i = 0; i < 20; i++) {
  await entry.takeover("replace", modes.plain, modes.state);
  await entry.takeover("adopt", modes.adopt, modes.state);
}
const replace = [];
const adopt = [];
for (let i = 0; i < runs; i++) {
  replace.push(await entry.takeover("replace", modes.plain, modes.state));
  adopt.push(await entry.takeover("adopt", modes.adopt, modes.state));
}
console.log(`\nTakeover in jsdom, median of ${runs} (Node ${process.versions.node})\n`);
console.log("| strategy | median | p90 |");
console.log("|---|---|---|");
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
console.log(`| replace | ${median(replace).toFixed(2)} ms | ${p90(replace).toFixed(2)} ms |`);
console.log(`| adopt | ${median(adopt).toFixed(2)} ms | ${p90(adopt).toFixed(2)} ms |`);
process.exit(0);
