import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Read the package version so the reactive runtime can stamp it onto the
// duplicate-instance registry (see src/reactivity/track.ts). `__SIBU_VERSION__`
// is a bundler define — under raw ESM / the test runner it is undefined and the
// runtime falls back to "dev". This config is auto-loaded by every `tsup`
// invocation in the build script (main + CDN), so the stamp lands in all
// outputs. Entry points / formats stay on the CLI; this only adds `define`.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SIBU_VERSION__: JSON.stringify(version),
  },
});
