import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Config for the ESM/CJS entry points. The CDN/IIFE builds use
// `tsup.cdn.config.ts` instead.
//
// Read the package version so the reactive runtime can stamp it onto the
// duplicate-instance registry (see src/reactivity/track.ts). `__SIBU_VERSION__`
// is a bundler define — under raw ESM / the test runner it is undefined and the
// runtime falls back to "dev". Entry points / formats stay on the CLI; this
// only adds `define`.
//
// `__SIBU_DEV__` is deliberately NOT defined here. These outputs are handed to
// the consumer's bundler, which defines it per build so dev diagnostics are
// live in development and compiled out in production. Pinning it either way
// here would take that choice away — and pinning it to `false` would silence
// every warning in development, which is the opposite of what they are for.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SIBU_VERSION__: JSON.stringify(version),
  },
});
