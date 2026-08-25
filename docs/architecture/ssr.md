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
once at module load. The store holds the SSR flag, the suspense-id counter, and
lazily-created request-scoped caches.

```text
Request A ──► runInSSRContext ──► store A { ssr, suspenseIdCounter, caches }
                                     │
                                     ├── survives every await in A
                                     └── invisible to B

Request B ──► runInSSRContext ──► store B { ssr, suspenseIdCounter, caches }
```

ALS propagates across `await`, so an interleaved render keeps its own store.
Verified with deliberately interleaved renders and with 100 concurrent renders
released in reverse order — every request saw only its own markers.

The instance is published on `globalThis` under
`Symbol.for("sibujs.ssr.v1")`, so duplicate copies of the module (which bundler
pre-bundling can produce) share one store rather than each keeping their own.

### `withSSR()` is not request-scoped

```ts
runInSSRContext(fn);  // per-request store — correct for a server
withSSR(fn);          // mutates the CURRENT store — fine for a one-shot render
```

`withSSR()` flips the flag on whatever store is active. Outside
`runInSSRContext` that is the process-global fallback. Use it for scripts and
tests; use `runInSSRContext` for anything serving concurrent requests.

On runtimes without `AsyncLocalStorage`, the store falls back to a module
global. **Concurrent rendering is not request-isolated there** — a documented
limitation for non-Node edge runtimes.

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
- `renderToSuspenseStream()` emits the shell, then each resolved boundary
  followed by a small swap script that moves the resolved content into place.

Suspense ids come from the **per-request** counter, so concurrent streaming
renders cannot collide on marker ids.

## Invariants

- Request-specific state may never leak between concurrent renders.
- Values rendered through safe text/attribute APIs may not escape their HTML
  context.
- Attacker-controlled serialized state may not terminate its script context.
- SSR module import must not touch browser globals at load time.
