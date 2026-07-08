import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SIBU_VERSION__: JSON.stringify(version),
  },
  // Keep @sibujs/core and sibujs external so labs never bundles its own copy of
  // the engine or the std layer (preserves single-runtime dedup). splitting:false
  // avoids esbuild dropping `export *` re-exports across the multi-entry build
  // (same fix as the sibujs package).
  external: [/^@sibujs\/core(\/.*)?$/, /^sibujs(\/.*)?$/],
  splitting: false,
});
