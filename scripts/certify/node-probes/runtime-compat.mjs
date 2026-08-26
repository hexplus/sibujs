// Node runtime-compatibility probe, executed against the PACKED package inside a
// throwaway consumer project. Covers the surfaces whose behaviour genuinely
// differs between Node release lines.
//
// Run with a DOM installed by the caller (jsdom), because SSR rendering takes
// real DOM nodes.
import { JSDOM } from "jsdom";

// A real URL matters: jsdom defaults to `about:blank`, whose pathname is the
// string "blank", so a history-mode router would bootstrap onto a route that
// does not exist and render nothing. `history` is copied across too — the
// router writes to it on every navigation (NODE-001).
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: "http://localhost/",
});
for (const k of [
  "window", "document", "HTMLElement", "Element", "Node", "DocumentFragment",
  "Comment", "Text", "customElements", "SVGElement", "Event", "CustomEvent",
  "MutationObserver", "getComputedStyle", "DOMParser", "history", "location",
]) {
  globalThis[k] = k === "window" ? dom.window : dom.window[k];
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};

// --- Node built-ins the framework relies on --------------------------------
const { AsyncLocalStorage } = await import("node:async_hooks");
check("AsyncLocalStorage available", typeof AsyncLocalStorage === "function");
check("AbortController available", typeof AbortController === "function");
check("AbortSignal.abort available", typeof AbortSignal?.abort === "function");
check("queueMicrotask available", typeof queueMicrotask === "function");
check("ReadableStream available", typeof ReadableStream === "function");
check("TextEncoder/TextDecoder available", typeof TextEncoder === "function" && typeof TextDecoder === "function");
check("structuredClone available", typeof structuredClone === "function");
check("timer.unref available", typeof setTimeout(() => {}, 0).unref === "function");
check("DOMException available", typeof DOMException === "function");

// --- SSR: render, serialize, stream ----------------------------------------
const ssr = await import("sibujs/ssr");
// NOTE: the SSR *context* API (runInSSRContext / getRequestScopedCache) ships
// from the CORE entry, not from `sibujs/ssr`, which carries the renderer.
const core = await import("sibujs");

{
  const el = document.createElement("div");
  el.textContent = "<script>alert(1)</script>";
  const html = ssr.renderToString(el);
  check("renderToString escapes", !/<script/i.test(html), html.slice(0, 60));
}

{
  const el = document.createElement("div");
  el.textContent = "streamed";
  const out = await ssr.collectStream(ssr.renderToStream(el));
  check("renderToStream + collectStream", out.includes("streamed"));
}

{
  const el = document.createElement("div");
  el.textContent = "web-stream";
  const rs = ssr.renderToReadableStream(el);
  const reader = rs.getReader();
  let acc = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += value;
  }
  check("renderToReadableStream (WHATWG)", acc.includes("web-stream"));
}

{
  const html = ssr.serializeState({ token: "</script><!--" });
  const body = html.slice(html.indexOf(">") + 1, html.lastIndexOf("<"));
  check("serializeState cannot break its script context", !/<\/script/i.test(body) && !body.includes("<!--"));
}

// --- SSR request isolation (AsyncLocalStorage) ------------------------------
{
  // Interleave two requests and confirm each keeps its own scoped cache.
  const seen = await Promise.all(
    ["A", "B"].map((tag) =>
      core.runInSSRContext(async () => {
        const before = core.getRequestScopedCache?.("query") ?? null;
        await new Promise((r) => setTimeout(r, 5));
        const after = core.getRequestScopedCache?.("query") ?? null;
        return { tag, before, after, stable: before === after };
      }),
    ),
  );
  const [a, b] = seen;
  const distinct = a.after !== null && b.after !== null && a.after !== b.after;
  check(
    "SSR request isolation (A sees A, B sees B)",
    distinct && a.stable && b.stable,
    distinct ? "distinct scopes" : "SCOPES SHARED OR UNAVAILABLE",
  );
}

// --- RC-003: promise-returning route component ------------------------------
{
  const { createRouter, destroyRouter, Route } = await import("sibujs/plugins");
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const mk = (t) => { const d = document.createElement("div"); d.textContent = t; return d; };

  const router = createRouter(
    [
      { path: "/", component: () => mk("home") },
      // NOT an `async function` — a plain arrow returning a promise.
      { path: "/p", component: () => Promise.resolve(mk("promised")) },
    ],
    { mode: "history" },
  );
  host.appendChild(Route());
  await new Promise((r) => setTimeout(r, 30));
  await router.push("/p").catch(() => {});
  await new Promise((r) => setTimeout(r, 60));

  check("RC-003 promise-returning component renders", host.textContent.includes("promised"), host.textContent);
  check("RC-003 no unhandled rejection", unhandled === null, unhandled ? String(unhandled) : "");
  process.off("unhandledRejection", onUnhandled);
  destroyRouter();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nruntime-compat: ${results.length - failed.length}/${results.length} checks passed`);
console.log(failed.length ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed.length ? 1 : 0);
