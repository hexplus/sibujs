# SSR fixture app

The acceptance fixture for server rendering. It has the shape of a real
production app: a Vite + TypeScript SPA with `createRouter({ mode: "history" })`
served as static files by a Python backend.

| Route | What it exercises |
|---|---|
| `/` | Landing page; the product grid comes from `fetch("/api/catalog")` through `query()` |
| `/producto/:id` | Param route, one page per catalog id (`getStaticPaths`) |
| `/cotizar?servicio=dtf` | Query route; a quote form (adoption keeps typed input) |
| `/cotizacion` | Permanent redirect to `/cotizar` |
| `/galeria` | Lazy route |
| `/ayuda/envios` | Nested layout with `Outlet()` |
| `/estado` | Status page rendered per request (`render: "ssr"`) |
| `/disenador` | Canvas + `document.fonts` designer, browser only (`render: "client"`) |
| `/admin` | Guarded admin panel, `noindex`, browser only |
| `*` | 404 page (`status: 404`) |

Product cards render the plain `<img>` on the server; in the browser
`ClientOnly` swaps in a recolored `<canvas>`.

The app reads its API through `globalThis.fetch`, so tests stub it and the
pre-render build points it at a running API with the `fetch` option.
