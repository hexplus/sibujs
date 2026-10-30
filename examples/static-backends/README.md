# Static backend (Python / Go / PHP) + SibuJS

Three ways to give crawlers and link-preview bots real content when the backend
is not Node. The examples use the fixture app in `fixtures/ssr-app` and FastAPI;
Go (`net/http` + `http.FileServer`) and PHP (Apache/nginx in front of
`dist/`) follow the same file mapping.

| | 1. Pre-render at build time | 2. Backend templates + islands | 3. Node render sidecar |
|---|---|---|---|
| HTML comes from | `vite build` (static files) | the backend's own templates | a Node process, per request |
| SibuJS on the server | at build time only | none | yes |
| Data freshness | as of the last build | live | live (cached per URL + data version) |
| Interactivity | the whole app takes over (`hydrate`, adopt or replace) | only the islands | the whole app takes over |
| Moving parts | none at runtime | none at runtime | one more service |
| Choose it when | pages change when you deploy or when an admin edits (rebuild) | the site is mostly server pages with a few widgets | pages are per-user or change too often to rebuild |

## 1. Pre-render at build time

```ts
// vite.config.ts
sibuVitePlugin({
  prerender: {
    server: "src/entry-server.ts", // exports `routes`, `head` (and optionally `routerOptions`, `app`)
    origin: "https://example.com",
    fetch: process.env.API_URL,    // the running API the pages read at build time
    hydration: "adopt",
    robots: true,
  },
});
```

`vite build` renders every route of the table (and each path a dynamic route's
`getStaticPaths()` returns) and writes:

| URL | File |
|---|---|
| `/` | `dist/index.html` |
| `/cotizar` → `/cotizar/` | `dist/cotizar/index.html` (`trailingSlash: "never"` writes `dist/cotizar.html`) |
| `/producto/taza/` | `dist/producto/taza/index.html` |
| a `render: "client"` route (`/admin/`) | `dist/admin/index.html` — the shell plus the route's `<head>` |
| unknown URL | `dist/404.html`, served with status 404 |
| a deep link the build did not list | `dist/200.html` — the untouched shell; the router renders it in the browser |
| redirects | `dist/redirects.json` — answer them in the backend (a static file cannot be a 301) |
| — | `dist/sitemap.xml`, `dist/robots.txt` |

The client entry starts the router with `trailingSlash: "ignore"` (static
servers serve `cotizar/index.html` at `/cotizar/`) and adopts the page:

```ts
createRouter(routes, { mode: "history", head, trailingSlash: "ignore" });
routerReady().then(() => hydrate(() => Route(), root, { strategy: "adopt" }));
```

The data the build fetched is embedded in each page, so the browser does not
request it again while it is fresh (`staleTime`).

Serving: [`fastapi/app.py`](fastapi/app.py) (redirects, immutable `/assets`,
`404.html`), or nginx:

```nginx
location /assets/ { expires max; add_header Cache-Control "public, immutable"; }
location / { try_files $uri $uri/index.html /200.html; }
error_page 404 /404.html;
```

**Freshness.** Rebuild when the data changes. A common setup: the admin's
"save" calls a webhook that runs `vite build` (or `sibujs prerender`) in CI and
syncs `dist/` — whole-site rebuilds of a few hundred pages take seconds with the
server DOM. `createISR()` does not help here: it is a client-side
stale-while-revalidate resource, not page regeneration. Pages served from a
pre-render refetch stale data in the background (`staleTime`), so a visitor
still sees fresh numbers after the bundle loads.

## 2. Backend templates + islands

The backend renders the page ([`islands/landing.html`](islands/landing.html),
a Jinja2 template); a small bundle ([`islands/islands.ts`](islands/islands.ts))
enhances the interactive parts in place with `registerIsland()` +
`mountIslands()`, honouring `data-sibu-load="visible" | "idle" | "interaction"
| "media"`. The rest of the page ships no SibuJS at all. Head tags are the
template's job.

## 3. Node render sidecar

[`sidecar/server.mjs`](sidecar/server.mjs) serves `createRenderHandler(routes)`:
status, `Location` and `Cache-Control` from the router, a full document with
the hashed bundle tags, adoption markers, and an in-memory cache keyed by URL +
data version (`POST /__invalidate` bumps it). The FastAPI app proxies HTML
routes to it when `SIBU_SIDECAR` is set and falls back to the pre-rendered files
when it is down — so option 3 can be added on top of option 1.
