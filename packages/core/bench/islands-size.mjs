// Measures the gzipped size of the no-build islands runtime — the bundle a page
// ships to make server-rendered HTML reactive: signal + effect + enhance + the
// island runtime. Run: `node bench/islands-size.mjs`.
import { build } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const entry = `
  export { signal } from "./src/core/signals/signal";
  export { effect } from "./src/core/signals/effect";
  export { enhance, enhanceAll } from "./src/platform/enhance";
  export { registerIsland, mountIslands, lazyIsland } from "./src/platform/islands";
`;

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
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log("Islands runtime — signal + effect + enhance + island runtime");
console.log("  minified:", kb(code.length));
console.log("  gzipped: ", kb(gzipSync(code).length));
console.log("  brotli:  ", kb(brotliCompressSync(code).length));
