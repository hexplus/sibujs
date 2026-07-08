import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Mirror the version-stamp define the reactive runtime expects (see
// src/reactivity/track.ts). `__SIBU_VERSION__` is a bundler define; under raw
// ESM / the test runner it is undefined and the runtime falls back to "dev".
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __SIBU_VERSION__: JSON.stringify(version) },
});
