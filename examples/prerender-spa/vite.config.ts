// Example: an SPA pre-rendered at build time.
//
// `npx vite build -c examples/prerender-spa/vite.config.ts` writes
// dist/index.html, dist/cotizar/index.html and dist/galeria/index.html, each
// with its own <title>, description and Open Graph tags and its rendered
// content, plus dist/200.html — the untouched shell for the backend's fallback.
//
// Inside this repository `sibujs` is aliased to the source; an app installs it
// from npm and needs only the plugin line.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { sibuVitePlugin } from "../../src/build/vite";

const src = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: /^sibujs$/, replacement: src("index.ts") },
      { find: /^sibujs\/(plugins|ssr)$/, replacement: src("$1.ts") },
    ],
  },
  plugins: [
    sibuVitePlugin({
      prerender: { routes: ["/", "/cotizar", "/galeria"], origin: "https://wraps.example" },
    }),
  ],
});
