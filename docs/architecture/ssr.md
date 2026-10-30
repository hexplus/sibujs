# Server-Side Rendering

## Render pipeline

```text
request
   │
   ▼
runInSSRContext(() => { ... })     ← per-request AsyncLocalStorage scope
   │                                 (renderRoute / renderToStringAsync open one)
   ▼
build DOM tree                     ← happy-dom, jsdom, or the built-in server DOM
   │
   ▼
settled()                          ← directive commits, lazy chunks, fetches,
   │                                 router loads registered in THIS request
   ▼
renderToString(element)            ← serialise DOM → HTML string
   │
   ▼
collected head + transfer script   ← escaped, nonce-aware
   │
   ▼
response
```

Since 4.14 `renderToStringAsync()` / `renderToDocumentAsync()` /
`renderRoute()` run the whole pipeline; `renderToString` remains the
synchronous serializer of a tree as it is.

## SSR requires a DOM implementation

`renderToString(element: HTMLElement | DocumentFragment | Node)` takes a **real
DOM node** and serialises it. Building that tree calls `document.createElement`
and checks nodes with `instanceof Node` / `HTMLElement`, so the DOM
implementation's globals must exist on the server before the first builder runs:

```js
// happy-dom: one call registers every global.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

// jsdom: register the globals SibuJS reads.
import { JSDOM } from "jsdom";
const { window } = new JSDOM("");
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  DocumentFragment: window.DocumentFragment,
});
```

`jsdom`, `happy-dom`, and `linkedom` all work; `tests/ssr-dom-setup.test.ts` runs
the jsdom recipe in a bare Node environment. Without a DOM, the first tree
builder (`div()`, `svg()`, `html`, `Fragment`, `when`, `match`, `each`, `KeepAlive`, `Portal`) throws
`renderToString needs a DOM: register happy-dom or jsdom globals first` (since
4.12; it used to be `ReferenceError: document is not defined`).

### The built-in server DOM (4.14)

`sibujs/ssr/dom` (`src/platform/serverDom.ts`) is a minimal DOM implementing
only what the runtime and the serializer use. The async renderers install it
when no DOM is registered; `installServerDom()` does it explicitly and never
replaces an existing DOM. It is NOT the "DOM-free path" declined in 4.12, which
would have routed every DOM access in the core through an indirection every
client bundle pays for: the core is unchanged and still talks to `document`;
the server DOM is just another `document`, shipped only in `sibujs/ssr`.

- **Parity.** Output is byte-identical to jsdom's on the fixture pages and on a
  page covering every serializer path (`tests/ssr-server-dom.node.test.ts`).
  `style` values are kept as written (no CSSOM normalization); happy-dom's CSSOM
  expands shorthands in a string `style`, which is the one difference from it.
- **Form controls** follow the browser's IDL rules the attribute writer relies
  on: `value` / `checked` / `selected` are state that does not reflect,
  `disabled` reflects.
- **Browser-only APIs** throw an error naming the API and the calling source
  frame (`animate()`, `showModal()`, `requestFullscreen()`, `innerHTML =`); probes
  (`canvas.getContext()`, `document.fonts`) answer "unavailable" and are
  recorded in `diagnostics.browserApis`. There is no `window`.
- **Cost** (`npm run bench:ssr`, fixture landing page, 1 000 renders, Node 24):

| DOM | per render | heap to register | heap after 1 000 renders |
|---|---|---|---|
| server DOM | 0.24 ms | 1.0 MB | 4.4 MB |
| jsdom | 0.86 ms | 16.2 MB | 20.4 MB |
| happy-dom | 0.81 ms | 13.0 MB | 13.8 MB |

### Waiting for the tree (4.14)

`when`, `match` and `each` render their first branch in a microtask, `lazy()`
chunks, fetches and router loads later. `settled()` waits for all of it, per
request: work is registered with `trackPending()` (which `lazy()`, `query()`,
`resource()`, `prerenderWait()` and the router call) on the request's
`SSRStore.pending`, and the loop runs macrotask turns until that set is empty
twice in a row, or the timeout. A timed-out render serializes what is ready.

**What does work without a DOM** (verified in a bare Node environment,
`tests/ssr-hardening-node-env.test.ts`):

| Capability | Works without DOM? |
|---|---|
| Importing the SSR module | yes |
| `serializeState` / `escapeScriptJson` | yes |
| `deserializeState` (returns `undefined`) | yes |
| SSR context / `runInSSRContext` / `isSSR` | yes |
| `resolveServerRoute` — matching, params, query, hash, redirects | yes |
| Building elements (`div(...)`) and `renderToString` | needs a DOM — the built-in server DOM is enough |
| `renderToStringAsync` / `renderRoute` / the server-entry pre-renderer | yes — they install the server DOM |

## Request isolation

This is the invariant that matters most on a server:

> Request-specific SibuJS state may never leak between concurrent SSR renders.

SibuJS backs its per-request store with Node's **`AsyncLocalStorage`**, detected
once at module load. The store holds the SSR flag, the suspense-id counter, the
active i18n locale, and lazily-created request-scoped caches.

```text
Request A ──► runInSSRContext ──► store A { ssr, suspenseIdCounter, locale, caches }
                                     │
                                     ├── survives every await in A
                                     └── invisible to B

Request B ──► runInSSRContext ──► store B { ssr, suspenseIdCounter, locale, caches }
```

ALS propagates across `await`, so an interleaved render keeps its own store.
Verified with deliberately interleaved renders and with 100 concurrent renders
released in reverse order — every request saw only its own markers.

The instance is published on `globalThis` under
`Symbol.for("sibujs.ssr.v1")`, so duplicate copies of the module (which bundler
pre-bundling can produce) share one store rather than each keeping their own.

### i18n locale ownership

The active locale is per-visitor, so on a server it is per-request. Inside
`runInSSRContext` it lives in that request's store:

```ts
runInSSRContext(async () => {
  setLocale("es");        // this request only
  await loadData();
  return t("greeting");   // "Hola" — even if another request chose "en"
});
```

Outside a request scope `setLocale()` updates the client locale reactively,
exactly as it always has, so browser apps are unaffected and need no explicit
i18n object.

**Translation dictionaries stay application-global.** They are static data:
registered once at startup, read identically by every request. Copying them per
request would duplicate every message for no benefit and force each request to
re-register before it could translate anything. `registerTranslations()` merges,
so it never drops what was registered before — including when called from inside
a request, where the result is visible to every other request and to the client.

A request that never calls `setLocale()` follows the application default (`"en"`
unless the application changed it at startup). An SSR request never writes to
that default: it cannot change what a concurrent request, or the client, renders.

Live bindings — `translated(key)`, `Trans(key)`, `() => t(key)` — evaluate once
on the server with the request's locale. Server renders subscribe neither to the
client locale nor to dictionary registration, so a later `registerTranslations()`
never re-runs anything a request rendered. On the client the same bindings
update in place when the locale changes or messages arrive.

### `withSSR()` is not request-scoped

```ts
runInSSRContext(fn);  // per-request store — correct for a server
withSSR(fn);          // mutates the CURRENT store — fine for a one-shot render
```

`withSSR()` flips the flag on whatever store is active. Outside
`runInSSRContext` that is the process-global fallback. Use it for scripts and
tests; use `runInSSRContext` for anything serving concurrent requests.

`withSSR()` therefore does not scope the locale either: a `setLocale()` inside
it updates the client locale, because no request store was created.

On runtimes without `AsyncLocalStorage`, the store falls back to a module
global. **Concurrent rendering is not request-isolated there** — a documented
limitation for non-Node edge runtimes. `runInSSRContext` saves and restores that
shared store around the call, which is correct for a fully synchronous render;
an `async` callback's scope ends at its first `await`, after which reads fall
back to the process-wide values. This applies to the locale exactly as it does
to the SSR flag and the suspense counter.

## Escaping

| API | Escapes? | Notes |
|---|---|---|
| Text children via `div("...")` etc. | **yes** | `&`, `<`, `>` entity-encoded |
| Attribute values | **yes** | `&`, `"`, `'`, `<`, `>` encoded |
| `serializeState()` | **yes** | see below |
| `escapeScriptJson()` | **yes** | `<`, `>`, `&`, U+2028, U+2029 |
| `trustHTML()` | **NO — by design** | explicit opt-out; never pass user input |

`trustHTML()` is the one intentional escape hatch. Its name is the warning.

URL-bearing attributes additionally run through `sanitizeUrl`, and `on*`
attributes are dropped during document rendering.

## Serialized state

```ts
serializeState({ user }, nonce)
// → <script nonce="...">window.__SIBU_STATE__={"user":"..."}</script>
```

Escaping replaces `<` → `<`, `>` → `>`, `&` → `&`, plus U+2028 /
U+2029. That neutralises `</script>`, `<!--`, and `-->`, so attacker-controlled
data cannot terminate the script context. The escapes live inside a JSON string
literal, so `JSON.parse` restores the original values exactly — round-tripping
is lossless.

Payloads are capped at 1 MB by default (`maxBytes`) and throw rather than emit
an oversized document.

`deserializeState(validate)` accepts an optional type guard. Development builds
warn when it is called without one, because a tampered payload would otherwise
be trusted.

## Async and streaming

- `renderToStream(element)` yields chunks as an `AsyncGenerator<string>`.
- `renderToReadableStream(element)` wraps that in a Web `ReadableStream` with
  pull-based backpressure and a `cancel()` that returns the generator.
- `ssrSuspense({ fallback, content })` emits fallback markup carrying a
  `data-sibu-suspense-id`, and resolves to the real content later.
- `renderToSuspenseStream()` emits the shell, then — once **every** boundary has
  settled — each resolved boundary followed by a small swap script that moves
  the resolved content into place.

**Environment.** Every streaming API above requires a server DOM implementation,
exactly like the non-streaming ones: they take real `Node` objects and walk
them. Returning a Web `ReadableStream` does not make `renderToReadableStream`
usable in a DOM-less runtime. The supported floor is SibuJS's declared Node
version (`>=22.3.0`) plus a DOM (`jsdom`, `linkedom`, `happy-dom`).

### Out-of-order streaming (4.14)

`renderToReadableStream(() => App(), options)` — a function, not a node —
streams per boundary. `Suspense` reports its container to the streaming render
(`core/rendering/streamBoundary.ts`); work started while a boundary's content
builds is attributed to it, and a `lazy()` created inside it renders inside it.
The head and the shell flush once the work attributed to no boundary has
settled; a boundary not yet ready is serialized with its fallback (its
in-progress content held aside for the moment). Each boundary then streams as
soon as its own work has settled — `<div hidden id="sibu-resolved-…">` plus
`suspenseSwapScript()` — in finishing order; a ready boundary nested in a
streamed one travels with it. Chunks are produced on demand (a one-slot channel:
the renderer waits until the consumer read the previous chunk), and `cancel()`
stops the render. The node form below is unchanged.

### Streaming is shell-then-batch, not per-boundary progressive (the node form)

This distinction is easy to misread, so it is worth stating precisely.

```
shell HTML (with fallbacks)  ──► flushed immediately
                                      │
                          await Promise.all(all boundaries)   ← one barrier
                                      │
boundary A + swap script     ──┐
boundary B + swap script     ──┤ flushed together, after the SLOWEST settles
boundary C + swap script     ──┘
```

`renderToSuspenseStream()` awaits `Promise.all(pendingBoundaries)` before
emitting any of them. A boundary that resolves in 5 ms is therefore not sent
until the boundary that takes 3 s is done. What streams early is the **shell**;
what does not stream is the boundaries relative to *each other*.

This is genuinely useful — first paint does not wait on data — but it is not
per-boundary progressive streaming, and it should not be described as such.
Under a slow boundary, total time-to-content is governed by the slowest one.

### Suspense failure semantics

`ssrSuspense` resolves to the **fallback HTML** in all three non-success cases:

| Outcome | Emitted markup |
|---|---|
| Still pending when the shell flushes | fallback |
| Timed out (`timeoutMs`, default 30 000) | fallback |
| Content promise rejected | fallback |

The consequence to be explicit about: **the emitted markup does not distinguish
a permanently failed boundary from one that is merely still pending.** Both look
like a rendered fallback. A rejection is logged in development
(`[SibuJS SSR] ssrSuspense rejected:`), but the HTML carries no failure marker
and no client-side signal that the boundary will never arrive. An application
that must tell the two apart has to carry that state in its own payload.

Suspense ids come from the **per-request** counter, so concurrent streaming
renders cannot collide on marker ids.

### `query()` under SSR

Before 4.14 this section said `query()` fetched during server rendering; it did
not. Its request started inside an `effect()`, and effects are no-ops under SSR,
so a query on the server never fetched and `data()` stayed at `initialData`.

Since 4.14 the query's internal effects run on the server (`effect(fn, {
server: true })`): it fetches, results land in the **request-scoped** cache, and
the request is registered so the async renderers wait for it. Intervals and
window-focus / reconnect listeners are never installed on the server;
`enabled: false` and `ssr: false` queries do not fetch. `renderToString` still
serializes synchronously and waits for nothing.

### Data transfer (4.14)

After the render settles, the request's query cache, keyed resources and
loaders are collected (`utils/transfer.ts`: one collector per section) into ONE
script, `window.__SIBU_TRANSFER__ = {"v":1,"q":{…},"r":{…}}`, escaped by
`escapeScriptJson`, with the render's nonce. The payload is capped
(`maxStateBytes`, 1 MB): entries are dropped largest first and named in a dev
warning. `__proto__`-style keys never cross in either direction. The browser
reads the global once (own property only, plain objects only, version checked)
and primes its cache: each query entry keeps the server's `dataUpdatedAt`, so
staleness is measured from when the server fetched it. A request's collectors
read only that request's caches, which is what keeps concurrent renders apart
(`tests/ssr-data-transfer.test.ts`).

## Invariants

- Request-specific state may never leak between concurrent renders.
- Values rendered through safe text/attribute APIs may not escape their HTML
  context.
- Attacker-controlled serialized state may not terminate its script context.
- SSR module import must not touch browser globals at load time.
