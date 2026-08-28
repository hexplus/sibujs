# Server-Side Rendering

## Render pipeline

```text
request
   │
   ▼
runInSSRContext(() => { ... })     ← per-request AsyncLocalStorage scope
   │
   ▼
build DOM tree                     ← requires a DOM implementation
   │
   ▼
renderToString(element)            ← serialise DOM → HTML string
   │
   ▼
serializeState(state, nonce)       ← escaped <script> payload
   │
   ▼
response
```

## SSR requires a DOM implementation

`renderToString(element: HTMLElement | DocumentFragment | Node)` takes a **real
DOM node** and serialises it. Building that tree calls `document.createElement`,
so a DOM implementation must exist on the server:

```js
// Node has no document — install one before rendering.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;
```

`jsdom`, `happy-dom`, and `linkedom` all work. This differs from frameworks that
render straight to a string, and it is a real deployment consideration: it costs
memory per process and rules out DOM-less edge runtimes.

**What does work without a DOM** (verified in a bare Node environment,
`tests/ssr-hardening-node-env.test.ts`):

| Capability | Works without DOM? |
|---|---|
| Importing the SSR module | yes |
| `serializeState` / `escapeScriptJson` | yes |
| `deserializeState` (returns `undefined`) | yes |
| SSR context / `runInSSRContext` / `isSSR` | yes |
| `resolveServerRoute` — matching, params, query, hash, redirects | yes |
| Building elements (`div(...)`) and `renderToString` | **no** |

So server-side *routing* is DOM-free; server-side *rendering* is not.

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

### Streaming is shell-then-batch, not per-boundary progressive

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

`query()` **does** fetch during server rendering. Its effect runs on creation and
starts a request like it would on the client; results land in the
**request-scoped** cache (see [Request isolation](#request-isolation) above), not
the process-global one, so concurrent requests cannot read each other's data.

What SSR does *not* do is wait for those requests before serializing: nothing in
`renderToString`/`renderToStream` blocks on in-flight queries. To get data into
server markup, resolve it before rendering, or put the dependent subtree behind
`ssrSuspense`.

## Invariants

- Request-specific state may never leak between concurrent renders.
- Values rendered through safe text/attribute APIs may not escape their HTML
  context.
- Attacker-controlled serialized state may not terminate its script context.
- SSR module import must not touch browser globals at load time.
