import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// CDN / IIFE build config. Unlike the module builds (tsup.config.ts), the
// standalone <script> bundle has no module resolution, so @sibujs/core — a
// runtime dependency tsup would externalize by default — must be INLINED.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SIBU_VERSION__: JSON.stringify(version),
  },
  noExternal: [/^@sibujs\/core(\/.*)?$/],
});
