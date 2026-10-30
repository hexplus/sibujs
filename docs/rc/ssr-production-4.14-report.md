# SSR production readiness (4.14) — report

Branch `feat/ssr-production-4.14` (framework), `feat/prerender-ssr-templates`
(sibujs-cli 1.7.0), `docs/agents-ssr-4.14` (sibujs-web, AGENTS.md). The audit
done before any code is [ssr-production-4.14-audit.md](./ssr-production-4.14-audit.md).

Final state: 9,324 unit tests pass (9,190 at the start; 1 skipped), 9 new
real-browser checks pass in Chromium, Firefox and WebKit, `sibujs-cli` 487
tests pass. The acceptance fixture is `fixtures/ssr-app` (the reference app's
shape: history router, a landing page whose grid comes from
`fetch("/api/catalog")`, cards swapping `<img>` for a recolored `<canvas>`, a
quote form, a canvas + `document.fonts` designer, a status page, an admin
panel, a guarded account page, a 404).

## What shipped

| Item | Shipped | Where |
|---|---|---|
| 1.1 Await everything | `renderToStringAsync`, `renderToDocumentAsync`, `settled`, timeout + diagnostics, `{ html, head, state, status, diagnostics }` | `platform/ssrAsync.ts`, `core/ssr-context.ts` |
| 1.2 No happy-dom/jsdom | `sibujs/ssr/dom`, auto-installed; parity with jsdom; benchmark | `platform/serverDom.ts` |
| 1.3 Server vs browser | `isServer`/`isClient`, `ClientOnly`, `effect({ server })`, `onMount` off under SSR, browser-API reports | `core/rendering/clientOnly.ts` |
| 2.1 Router on the server | memory mode + `url`, request-scoped, `renderRoute` with status/Location, `status`, `trailingSlash` | `plugins/router.ts`, `platform/renderRoute.ts` |
| 2.2 One head API | `robots`, `twitter`, `alternates`, `jsonLd`; server collection of route head and `Head()` | `plugins/routeHead.ts`, `platform/serverHead.ts` |
| 2.3 Render modes | route `render: "ssr" \| "prerender" \| "client"` | `plugins/router.ts` |
| 3.1 Adopting hydration | `hydrate(…, { strategy: "adopt" })` | `core/rendering/adoptScope.ts`, `platform/hydrateAdopt.ts` |
| 3.2 Data transfer | query cache, keyed resources, loaders; `ssr: false`; cap | `utils/transfer.ts` |
| 4.1 Build-time pre-rendering | server-entry mode with `getStaticPaths`, `fetch`, 404, sitemap, robots, redirects; CLI `sibujs prerender` | `build/prerenderServer.ts`, sibujs-cli |
| 4.2 Non-Node backends | recipe + runnable FastAPI / islands / sidecar examples; `createRenderHandler` | `examples/static-backends`, `platform/renderHandler.ts` |
| 5.1 Islands from SSR | `island(name, Component, props)`, `islandComponent()` | `platform/componentIsland.ts` |
| 5.2 Out-of-order streaming | `renderToReadableStream(() => App())` | `platform/ssrStream.ts`, `core/rendering/streamBoundary.ts` |
| 5.3 Testing utilities | `renderOnServer`, `hydrateInTest` | `testing/ssr.ts` |
| 6 Tooling | CLI `create --prerender` / `--ssr`, `build --ssr <entry>`, `prerender`; `bench:ssr` in CI; `formatRenderDiagnostics` / `log` | sibujs-cli, `bench/` |

Acceptance, as tested:

- A page with nested `when` > `each` > `lazy()` > `query()` serializes completely
  with one `await`; a slow resource hits the timeout and keeps its fallback
  (`tests/ssr-async-render.test.ts`).
- The fixture renders with no DOM library installed, byte-identical to jsdom
  (`tests/ssr-server-dom.node.test.ts`); missing APIs name the API and the
  caller.
- The canvas card renders `<img>` on the server and `<canvas>` in the browser;
  the designer is `render: "client"` and the build does not touch it.
- `/`, a param route, a query route, a redirect (status + Location, no body), a
  404, a lazy route, a nested layout, guarded routes (403 and 302)
  (`tests/ssr-render-route.test.ts`). Each fixture route serves its own title /
  description / OG tags and a link-preview parse passes for all of them
  (`tests/ssr-head-unified.test.ts`).
- Adoption on the fixture landing page creates no element besides the three
  `ClientOnly` canvases, keeps the exact hero `<img>`, makes no `/api/catalog`
  request; a deliberate mismatch replaces only its subtree and warns; typed
  input and focus survive (`tests/ssr-hydrate-adopt.test.ts`, and in three real
  browsers `tests-browser/ssr-prerender-takeover.spec.ts`).
- `vite build` of the fixture writes `index.html`, `cotizar/index.html`, one
  page per product, `404.html`, `200.html`, `sitemap.xml`, `robots.txt`; a plain
  `python -m http.server` serves the grid and the OG tags; the browser takes
  over with no console errors (`tests/prerender-server-entry.test.ts`,
  `tests-browser/ssr-prerender-takeover.spec.ts`).
- A marketing page with one island adopts only the island; nothing outside it
  is touched and a lazy island's chunk loads only when it activates
  (`tests/ssr-component-islands.test.ts`).

## Benchmarks (`npm run bench:ssr`, Node 24, Windows dev machine)

| 1 000 renders of the landing page | per render | heap to register the DOM | heap after |
|---|---|---|---|
| server DOM | 0.24 ms | 1.0 MB | 4.4 MB |
| jsdom | 0.86 ms | 16.2 MB | 20.4 MB |
| happy-dom | 0.81 ms | 13.0 MB | 13.8 MB |

| Landing page body | raw | gzip |
|---|---|---|
| `renderToString` (marker on every element) | 1 766 B | 510 B |
| async renderers (root marker only) | 1 325 B | 493 B |
| with adoption ids | 2 090 B | 598 B |
| transfer script | 404 B | 261 B |

| Takeover in jsdom (median of 300) | median | p90 |
|---|---|---|
| replace | 0.65 ms | 0.85 ms |
| adopt | 0.95 ms | 1.4 ms |

Read the takeover numbers carefully. In script time adoption is ~0.3 ms
*slower* on this page: claiming, attribute reconciliation, the session's
instance overrides and the final sweep cost more than building ten fresh
elements. What adoption saves is not measurable in jsdom — the browser does
not tear down and repaint the page, images and iframes do not reload, typed
input and focus survive. Choose it for those, not for CPU time.

CDN core (`cdn.global.js`): 89,460 → 91,774 B raw, 30,445 → 31,555 B gzip
(+3.6 %). The budget test was raised three times, each with the reason recorded
in `tests/dist-artifacts.test.ts`.

## Design decisions and trade-offs

**Adoption ids are creation-scope paths.** The design note proposed a
request-wide creation counter. It cannot survive a real server render: data
arrives, a `when` rebuilds its branch, and every element created afterwards is
numbered differently from the browser's single build; two boundaries finishing
in a different order shift each other. Each directive now reserves a slot in
its parent scope when it is created (synchronously, so deterministically) and
numbers its own content from 0 on every build; `each` rows and route records
are keyed by a hash of their key. Placeholders that a boundary replaces
(`lazy()`'s loading span, a `Suspense` fallback) are built outside any scope so
they cannot shift the ids after them.

**Text and comment nodes are swapped, not adopted.** Bindings close over the
text nodes they create, and text nodes cannot carry ids. A fresh text/comment
node takes the place of its server counterpart (found past preceding branch
content); adjacent server text nodes are kept apart with `<!--|-->`. The
acceptance criterion (zero elements created, `<img>` kept) holds; the design
note's "zero `childList` mutations" became "zero element mutations".

**Placement through instance overrides, not core hooks.** Claimed elements get
own-property `appendChild` / `insertBefore` / `replaceChildren` /
`textContent` for the length of the session, so the core's existing calls place
children on the server nodes. The core needed only the scope hooks and three
in-place guards. The cost: those instances carry own properties until the
session ends.

**Attributes end client-authoritative.** Server attributes are removed at
claim except those whose removal changes live state (`src`, `value`, `checked`,
`open`, …); kept ones are re-checked against the URL policy at once and dropped
at the end unless the client wrote or read them. Injected `javascript:` values
in cached markup do not survive.

**The effect-on-server rule.** The brief recommended "effects run once on the
server unless marked `{ client: true }`". That would have changed every
existing app's server render (effects touching `window`, timers, subscriptions)
— the opposite of the opt-in rule. Effects therefore stay client-only, as
`ssr-context.ts` always documented, and `effect(fn, { server: true })` opts in.
The data primitives opt their own effects in, which is what makes `query()`
fetch on the server.

**`onMount` under SSR.** It used to run whenever a DOM was registered,
contradicting the documented contract. It is now off inside an SSR scope. Listed
as a behavior change in the upgrade notes.

**Data-transfer format.** One script assigning `window.__SIBU_TRANSFER__`
(versioned, sections `q` / `r`, `{ d: data, t: dataUpdatedAt }` per query),
escaped by the existing `escapeScriptJson`, with the render's nonce and a byte
cap. A JSON `<script type="application/json">` would avoid the nonce, but the
brief asked to reuse `serializeState`, whose format and escaping are already
audited. Staleness keeps the server's timestamp, so a pre-rendered page's data
is as old as the build and refetches in the background past `staleTime`.

**Pre-rendering keeps the 4.13 mode and adds a server-entry mode.** The 4.13
pre-renderer runs the client entry in jsdom workers with zero configuration;
it stays exactly as it was (its new outputs are opt-in). The server-entry mode
needs one extra file exporting the route table, and in exchange renders with
`renderRoute` on the server DOM (no jsdom, ~3.5× faster per page), gets HTTP
status, `getStaticPaths`, render modes and state transfer. A small Vite plugin
injects a driver module into the SSR build so the driver and the app share one
copy of SibuJS.

**Guard redirects are not static redirects.** A guard redirect (`/dashboard` →
`/login`) depends on the visitor, so the pre-renderer skips the route instead of
writing it to `redirects.json`; `renderRoute` reports `redirectBy` so a sidecar
can tell them apart too.

**Route `meta` vs `head`.** The brief named the option `meta`; `meta` already is
free-form route metadata, and 4.13 shipped `head` for exactly this. 4.14 extends
`head`.

**Streaming attribution.** Pending work is attributed to the `Suspense`
boundary whose content was building when it started; `lazy()` captures the
boundary at creation. Work started later by a reactive re-run is unattributed
and holds the shell — correct, if conservative.

## Known limitations

- Adoption: `KeepAlive`, `DynamicComponent`, `Portal`, `KeepAliveRoute` and
  elements made with `document.createElement` open no scope; their content is
  rebuilt locally (and reported). Server output must not be reformatted between
  render and delivery.
- Head entries a `Suspense` boundary adds after the shell flushed are not in a
  streamed page's head; streaming starts at status 200.
- `renderToString` is still synchronous and does not wait; the async renderers
  are the new path.
- The server DOM has no HTML parser (`innerHTML =` throws) and no CSSOM
  normalization of style values.
- Isolation of concurrent renders requires `AsyncLocalStorage` (Node ≥ 22.3 for
  ESM); unchanged from before.
- The browser-API watch under happy-dom / jsdom reports reads of
  `localStorage`, `matchMedia`, `requestAnimationFrame`, the observers,
  `document.fonts` and `getContext()`; reading `window` itself is not reported
  there (the framework reads it too), only under the server DOM.
- The AGENTS.md drift test in `sibujs-web` resolves imports against the
  installed `sibujs`; it passes once that dependency is bumped to the published
  4.14.0.

## Chosen not to do

- **No silent change of `effect()` on the server** (see above).
- **No `useHead()`.** Component head entries go through the existing `Head()`;
  `use*` naming is not used in this codebase.
- **No `<meta http-equiv="refresh">` pages for redirects** in the static output:
  meta refresh is refused by the runtime policy; redirects are listed for the
  backend instead.
- **`createISR()` is not integrated:** it is a client-side stale-while-revalidate
  resource, not page regeneration. Freshness for static output is a rebuild
  (`sibujs prerender --routes …` from a webhook), documented in the recipe.
- **The CLI's template certification script** (`npm run certify` in sibujs-cli)
  installs from the registry; it was not extended to the new flags because
  their templates need the unpublished `sibujs` 4.14. They were verified by
  scaffolding against the local build instead (build, `sibujs prerender
  --routes`, the SSR server answering 200 / 404 / 302).
