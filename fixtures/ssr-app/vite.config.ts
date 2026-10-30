// The SSR fixture app, pre-rendered at build time from its server entry.
//
//   SIBU_FIXTURE_API=http://127.0.0.1:8787 npx vite build -c fixtures/ssr-app/vite.config.ts
//
// Writes dist/index.html, dist/cotizar/index.html, dist/producto/<id>/index.html
// (from getStaticPaths), dist/404.html, dist/200.html (the shell for browser-only
// routes), dist/sitemap.xml and dist/robots.txt. Inside this repository `sibujs`
// is aliased to the source; an app installs it from npm.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { sibuVitePlugin } from "../../src/build/vite";

const src = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: /^sibujs$/, replacement: src("index.ts") },
      { find: /^sibujs\/(plugins|ssr|data)$/, replacement: src("$1.ts") },
    ],
  },
  plugins: [
    sibuVitePlugin({
      prerender: {
        server: "src/entry-server.ts",
        origin: "https://fixture.test",
        fetch: process.env.SIBU_FIXTURE_API,
        hydration: "adopt",
        robots: "Disallow: /admin",
      },
    }),
  ],
});
