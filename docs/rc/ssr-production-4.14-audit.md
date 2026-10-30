# SSR production readiness (4.14) — audit before implementation

Baseline: `sibujs` 4.13.1, branch `feat/ssr-production-4.14` cut from
`e080eba`. Full suite at the start: 9,190 passed, 6 skipped, 0 failed.

Each item of the brief is classified as **exists**, **partial** or **missing**,
with the code that decides it. Where the code contradicts the brief, the code
wins and the difference is listed under "Brief vs. code".

## Brief vs. code

| The brief says | The code says |
|---|---|
| "request-scoped `query()` cache" fetches during SSR | `query()` starts fetching only inside `effect()`, and `effect()` is a no-op under `isSSR()` (`core/signals/effect.ts:211`). On the server a query never fetches, `data()` is only `initialData`, and the request-scoped cache stays empty. `docs/architecture/ssr.md` ("`query()` does fetch during server rendering") is wrong. |
| "route loaders" run during SSR | `data/routeLoader.ts` exists (`executeLoader`, `withLoader`, `loaderData`, `preloadRoute`) but the router never calls it: `RouteDef` has no `loader` field. Loaders are wired by the app. |
| route option `meta` for title/description/OG | `meta` already exists as free-form route metadata (`route().meta`). 4.13 added route **`head`** (`title`, `description`, `canonical`, `og`, `meta[]`) and `createRouter({ head })` with `titleTemplate`. 4.14 extends `head` rather than overloading `meta`. |
| `onMount`/`onUnmount` do not run on the server "(already the case)" | They are skipped only when `document` is undefined (`lifecycle.ts:321`, `:375`). With happy-dom/jsdom registered they **do** run inside `runInSSRContext`, contradicting the module comment in `ssr-context.ts` ("effect, watch, onMount should not run"). |
| AGENTS.md §17 is "build" | `sibujs-web/public/AGENTS.md` §17 is *Performance*; build tooling is covered under §3/§17. §9 router, §10 SSR, §11 islands, §18 testing, §22 common mistakes match. AGENTS.md lives in the `sibujs-web` repo, not in this package. |
| `serializeState` writes `__SIBU_STATE__` | It writes `window.__SIBU_SSR_DATA__` (`platform/ssr.ts:1291`); `docs/architecture/ssr.md` names the wrong global. |
| happy-dom is the reference DOM | The repo's dev DOM and the pre-renderer's DOM is **jsdom**; happy-dom is not installed. Parity snapshots are taken against jsdom (the DOM the 4.13 pre-renderer ships with). |
| `createMemoryRouter(routes, initialPath)` | Exists but ignores `initialPath` and is a hash-mode router (`router.ts:4001`). |

## Phase 1

### 1.1 Await everything before serializing — **missing**

- `renderToString` is synchronous. `when`/`match`/`each`/`KeepAlive` render
  their first branch in a `queueMicrotask` **only if the anchor has a parent by
  then** (`directives.ts:309`, `:438`, `each.ts:470`, `keepAlive.ts:138`);
  `Suspense` content and `Portal` content are microtask-deferred too.
- No pending-work registry exists anywhere in core or in the SSR store
  (`SSRStore` holds `ssr`, `suspenseIdCounter`, `idCounter`, `caches`, `locale`).
- `lazy()` tracks loading only as a DOM marker (`span.sibu-lazy-loading`);
  `Suspense` detects pending content only when its root is a `sibu-lazy`
  container, via a `MutationObserver` (`lazy.ts:207-222`).
- `resource(fetcher)` fetches under SSR (direct call), `resource(source,
  fetcher)` does not (inside `effect`). Neither exposes its promise.
- `query({ refetchInterval })` starts a `setInterval` with no SSR guard and no
  `unref()` (`query.ts:789`); focus/reconnect listeners attach whenever
  `globalThis.addEventListener` exists (true under a registered DOM).
- `ssrSuspense()` + `renderToSuspenseStream()` is an explicit, separate
  promise-based mechanism; it is not connected to `Suspense()`.
- The only waiting machinery is the 4.13 **build-time** pre-renderer
  (`build/prerender.ts`): it patches `fetch` and `Response` body readers in a
  jsdom worker, honours `prerenderWait()`, and waits for a DOM-quiet window.
  It is not available to an in-process render.
- Errors: there is no component stack (`RuntimeErrorContext` has `phase`,
  `name` — a primitive label — and `node`). Paths must be derived from the node.

### 1.2 Render without happy-dom/jsdom — **missing** (deliberately declined in 4.12)

- `requireDocument()` checks only `typeof document`; any object assigned to
  `document` passes.
- The core uses: `createElement(NS)`, `createTextNode`, `createComment`,
  `createDocumentFragment`, `createTreeWalker` (ErrorBoundary), `instanceof
  Node/Element/DocumentFragment`, numeric `nodeType`, `appendChild`,
  `insertBefore`, `removeChild`, `replaceChildren`, `remove`, `parentNode`,
  `nextSibling`, `previousSibling`, `childNodes`, `compareDocumentPosition`,
  attributes (+ NS variants), `textContent`, `style.setProperty/
  removeProperty/cssText/getPropertyValue/getPropertyPriority/length/[i]`,
  `classList.contains`, `querySelector(All)` (`lazy.ts`, focus preservation),
  `addEventListener`, `CustomEvent`/`dispatchEvent` (error propagation),
  `MutationObserver` (lifecycle, Suspense), `isConnected`, `contains`,
  `document.activeElement/body/head`.
- The serializer reads native prototype getters (`attributes`, `tagName`,
  `childNodes`, `getAttribute`) and uses `instanceof HTMLElement`, so a server
  DOM must expose `Node`/`Element`/`HTMLElement`/`DocumentFragment` with real
  prototype accessors.
- `sanitizeStyleAttribute` uses the DOM's CSS engine when `document` exists and
  a structural parser otherwise — the server DOM must route to the parser.

### 1.3 Server vs. browser code — **partial**

- `isSSR()` exists; `isServer()`/`isClient()` and `ClientOnly` are missing.
  `isPrerendering()` exists separately (`sibujs/ssr`), and the pre-renderer
  never enables SSR mode, so `isSSR()` is `false` while pre-rendering.
- `effect()`, `watch()`, `domBinding()` are no-ops under SSR; `derived()` and
  reactive DOM bindings evaluate (initial values are computed). No `client` /
  `server` option exists.
- No browser-API access detection exists.

## Phase 2

### 2.1 Render a URL through the router — **partial**

- The router is a process-wide singleton (`Symbol.for("sibujs.router.v1")`);
  `createRouter` destroys the previous instance. Concurrent server renders
  cannot each own a router; the pre-renderer works around it with one worker
  thread per route.
- Modes are `"history" | "hash"`; no `"memory"` mode and no initial `url`.
  Without `window` the router resolves `/`.
- `routerSSR.ts` (`resolveServerRoute`, `renderRouteToString`,
  `renderRouteToDocument`, `hydrateRouter`, `createSSRRouter`) is a **separate,
  simpler matcher** with its own `SSRRouteDef`: no guards, no `beforeEnter`, no
  lazy routes, no async components, no function redirects, no status. It stays
  as is (backward compatibility).
- `route()`, `routerState()`, `query`, `queryAll`, params are computed from the
  committed route with `URLSearchParams`, not `location` — they work with any
  navigation source. `Route()`/`Outlet()` render asynchronously (`await
  loadPlan`, `await instantiateScoped`).
- No HTTP status, no `Location`, no `status` field on routes. A rejected initial
  navigation leaves the placeholder route (`/`) committed.

### 2.2 One head API — **partial**

- Exists: route `head` + router `head` defaults, getters `(route) => string`,
  deepest-wins merge, dedupe by `name:`/`property:` key, OG fallbacks, URL
  allowlist for canonical/og:image/og:url, `data-sibu-head` ownership on the
  client, removal of keys the next route does not set, `resolveRouteHead()` /
  `routeHeadToHTML()` for server use.
- Missing: `robots`, `twitter`, `alternates` (hreflang), JSON-LD, server-side
  collection of component `Head()` entries (`Head()` writes straight into
  `document.head`; reactive values use `effect()`, so they are dropped under
  SSR), and a `head` field in any render result. `setStructuredData()` exists
  (client, escaped).

### 2.3 Per-route rendering mode — **missing**

No `render` option. The pre-renderer renders whatever route list it is given.

## Phase 3

### 3.1 Adopting hydration — **missing** (design only)

- `hydrate()` always replaces (`ssr.ts:579`); diagnostics are an opt-in
  lock-step walk. `docs/architecture/hydration-adopt.md` is a proposal.
- No claim/adopt hook exists in the core; the core has no component stack.
- `createId()` is request-scoped inside `runInSSRContext` (starts at 0, like a
  fresh client). It is not scoped by `enableSSR()` alone.
- `cdn.global.js` budget: raw ≤ 89,700 B, gzip ≤ 30,702 B; measured
  ~89,460 B / ~30,445 B. Core hooks must be small or the budget raised with a
  recorded reason (the established practice in `tests/dist-artifacts.test.ts`).

### 3.2 Transfer data — **missing**

- `serializeState`/`deserializeState` exist (escaped, 1 MB cap, nonce) but are
  not connected to `query()`, `resource()` or loaders.
- No dehydrate/prime API: `setQueryData` is a no-op for keys without an entry.
- `dataUpdatedAt` exists per cache entry and drives `isStale`.

## Phase 4

### 4.1 Build-time pre-rendering — **partial** (4.13 shipped the core of it)

Exists (`build/prerender.ts`, `sibuVitePlugin({ prerender })`): `routes`,
`entry`, `origin`, `timeout`, `settle`, `shell` (`200.html`), `concurrency`;
an SSR build of the app's own client entry, one jsdom worker per route, waits
for `fetch` + body reads + `prerenderWait()` + router readiness + DOM quiet,
writes `dist/<route>/index.html` with the live head, keeps the built asset tags,
path-traversal guards, failure on unhandled errors / timeout.

Missing: `outDir`, a `fetch` option (API base URL or custom function),
`trailingSlash`, `getStaticPaths`, `404.html`, `sitemap.xml`, `robots.txt`,
state transfer, `render: "client"` handling, a CLI command, and query variants
(they overwrite one file). `createISR()` is a **client-side**
stale-while-revalidate resource, not page regeneration; `generateStaticSite()`
collects HTML and writes nothing (`outDir` unused).

### 4.2 Non-Node backend recipe — **partial**

`examples/prerender-spa` is the reference app's shape (pre-rendered routes,
`/cotizar`, lazy `/galeria`). No recipe for the backend-template + islands
path or a Node sidecar.

## Phase 5

### 5.1 Component islands from SSR — **partial**

`island(id, () => el)` stamps `data-sibu-island`; `hydrateIslands` /
`hydrateProgressively` **replace**. `registerIsland` / `mountIslands` (`enhance`
model, `data-sibu-load` strategies `load|idle|visible|interaction|media`)
attach setup functions to existing markup. No serialized props, no adopting
island mount.

### 5.2 Out-of-order streaming — **partial**

`renderToReadableStream` has pull-based backpressure; `renderToSuspenseStream`
flushes the shell, then **all** boundaries after the slowest
(`Promise.all`). Swap scripts are nonce-aware. Not connected to `Suspense()`.

### 5.3 SSR testing utilities — **missing**

`sibujs/testing` has `render`, `fireEvent`, `waitFor`, `mockRouter`, queries,
snapshots. No server render or hydration helpers.

## Phase 6

- `sibujs-cli` 1.6.0: `create` (`--ui`, `--router`, `--tailwind`), `build
  --ssr` (passes `--ssr` to Vite, no entry), no `prerender`, templates have no
  `sibuVitePlugin`.
- Benchmarks: `bench.mjs` (runtime), `bench/islands-*.mjs`; nothing for SSR.

## Security policy inventory (applies to every new output path)

- Attribute values: `resolveAttributeValue` (URL allowlist `http/https/mailto/
  tel/ftp`/relative, `srcset` per candidate, `style` per declaration, refused
  value omitted), names `^[A-Za-z_:][-A-Za-z0-9_.:]*$`, `on*` dropped, `srcdoc`
  refused everywhere.
- Elements: `script`/`style` never serialized; runtime `script`/`iframe`/
  `object`/`embed`/`frame`/`frameset` refused by tag factories; contextual rules
  (`elementPolicy.ts`) for meta refresh, script `src`, stylesheet `href`, SVG
  animation targets.
- Head: `serializeHeadEntry` / `planMetaEntry` / `planHeadElementEntry`.
- Script payloads: `escapeScriptJson` (`<`, `>`, `&`, U+2028, U+2029), 1 MB cap,
  nonce.
- Raw HTML: `trustHTML()` only.
