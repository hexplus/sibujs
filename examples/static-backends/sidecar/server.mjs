// A Node render sidecar: renders HTML routes per request for a Python / Go /
// PHP backend that proxies (or calls) it.
//
//   npx vite build -c fixtures/ssr-app/vite.config.ts            # client bundle + shell
//   npx vite build -c fixtures/ssr-app/vite.config.ts --ssr src/entry-server.ts --outDir dist-server
//   SIBU_FIXTURE_API=http://127.0.0.1:8000 node examples/static-backends/sidecar/server.mjs
//
// The server entry exports `routes` and `head`; `createRenderHandler` turns them
// into a `Request → Response` handler with HTTP status, Location, Cache-Control
// and an in-memory cache keyed by URL + data version. POST /__invalidate (from
// the backend, after an admin edit) bumps the version.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
// The app's server bundle exports its routes AND the handler, so both use one
// copy of SibuJS.
import {
  createRenderHandler,
  head,
  routerOptions,
  routes,
} from "../../../fixtures/ssr-app/dist-server/entry-server.js";

const API = process.env.SIBU_FIXTURE_API ?? "http://127.0.0.1:8000";
// Relative API URLs in the app resolve against the backend.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  nodeFetch(typeof input === "string" && input.startsWith("/") ? API + input : input, init);

// The built shell carries the hashed client bundle tags.
const shell = readFileSync(new URL("../../../fixtures/ssr-app/dist/200.html", import.meta.url), "utf8");
const scripts = [...shell.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);

let dataVersion = 1;
const handle = createRenderHandler(routes, {
  router: { ...routerOptions, head },
  hydration: "adopt",
  document: { scripts },
  cache: { version: () => dataVersion, ttl: 5 * 60_000 },
});

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/__invalidate") {
    dataVersion++;
    res.writeHead(204).end();
    return;
  }
  try {
    // A fixed origin: the Host header is the client's to choose, and only the
    // path and query matter to the router.
    const url = new URL(req.url ?? "/", "http://sidecar.local");
    const response = await handle(new Request(url, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    // A malformed request-target; never let one take the process down.
    console.error("[sidecar]", err);
    if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
  }
}).listen(3001, "127.0.0.1", () => console.log("sibu sidecar on http://127.0.0.1:3001"));
