// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prerender } from "../src/build/prerender";

// ---------------------------------------------------------------------------
// The pre-renderer must wait for the response BODY the page consumes, not just
// for the headers `fetch()` resolves on.
//
// THE DEFECT: only the promise `fetch()` returned was tracked. It resolves when
// the headers arrive, so with a body that arrives later than the settle
// interval the page was serialized in its "loading" state.
//
// The server below flushes headers at once and holds every body for
// BODY_DELAY ms — ten times the default 50 ms settle — so a missed wait is
// deterministic, not a race.
// ---------------------------------------------------------------------------

const BODY_DELAY = 500;

let server: Server;
let origin: string;
let root: string;
const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, fn: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};

function headersNow(res: ServerResponse, type: string): void {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.flushHeaders();
}

// The app: plain DOM code, one scenario per route. Each renders "loading"
// first, so a page serialized too early is unmistakable.
const ENTRY = `
const app = document.getElementById("app");
app.textContent = "loading";
const show = (text) => { app.textContent = text; };
const scenarios = {
  "/json": () => fetch("/slow-json").then((r) => r.json()).then((d) => show("json:" + d.value)),
  "/text": () => fetch("/slow-text").then((r) => r.text()).then((t) => show("text:" + t)),
  "/clone": () => fetch("/slow-json").then((r) => r.clone().json()).then((d) => show("clone:" + d.value)),
  "/buffer": () =>
    fetch("/slow-text").then((r) => r.arrayBuffer()).then((b) => show("buffer:" + new TextDecoder().decode(b))),
  "/blob": () => fetch("/slow-text").then((r) => r.blob()).then((b) => b.text()).then((t) => show("blob:" + t)),
  "/form": () => fetch("/slow-form").then((r) => r.formData()).then((f) => show("form:" + f.get("v"))),
  "/handled-failure": () =>
    fetch("/broken").then((r) => r.text()).then(() => show("unexpected"), () => show("failed-handled")),
  "/unused-body": () => fetch("/endless").then((r) => show("headers:" + r.status)),
  "/unhandled-failure": () => fetch("/broken").then((r) => r.text()).then(show),
};
scenarios[location.pathname]?.();
`;

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case "/slow-json":
        headersNow(res, "application/json");
        later(BODY_DELAY, () => res.end(JSON.stringify({ value: "loaded" })));
        break;
      case "/slow-text":
        headersNow(res, "text/plain");
        later(BODY_DELAY, () => res.end("loaded"));
        break;
      case "/slow-form":
        headersNow(res, "application/x-www-form-urlencoded");
        later(BODY_DELAY, () => res.end("v=loaded"));
        break;
      case "/broken":
        // Headers, part of a body, then the connection dies: the body read rejects.
        headersNow(res, "text/plain");
        res.write("partial");
        later(BODY_DELAY, () => res.socket?.destroy());
        break;
      case "/endless":
        // A body that never finishes. Nobody reads it, so it must not hold the page.
        headersNow(res, "text/plain");
        res.write("tick");
        break;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Inside the repository's node_modules so the fixture resolves jsdom and
  // vite exactly as an app would; the directory is git-ignored.
  const cache = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, "sibu-prerender-fetch-"));
  await writeFile(join(root, "package.json"), '{ "name": "fixture", "private": true, "type": "module" }');
  await writeFile(join(root, "main.js"), ENTRY);
}, 30_000);

afterAll(async () => {
  for (const t of timers) clearTimeout(t);
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function run(routes: string[], outName: string) {
  const outDir = join(root, outName);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "index.html"),
    '<!doctype html><html><head><title>Fixture</title></head><body><div id="app"></div></body></html>',
  );
  const results = await prerender(
    // Default settle (50 ms) on purpose; the timeout only bounds a hang.
    { routes, origin, entry: "main.js", timeout: 4_000, shell: false },
    { root, outDir, configFile: false, mode: "production" },
  );
  const page = async (route: string) => {
    const file = results.find((r) => r.route === route)?.file;
    if (!file) throw new Error(`no output for ${route}`);
    const html = await readFile(join(outDir, file), "utf8");
    return /<div id="app">([\s\S]*?)<\/div>/.exec(html)?.[1];
  };
  return { results, page };
}

describe("prerender waits for consumed response bodies", () => {
  let out: Awaited<ReturnType<typeof run>>;

  beforeAll(async () => {
    out = await run(
      ["/json", "/text", "/clone", "/buffer", "/blob", "/form", "/handled-failure", "/unused-body"],
      "out-ok",
    );
  }, 60_000);

  it("json(): the page contains the loaded data, not the loading state", async () => {
    expect(await out.page("/json")).toBe("json:loaded");
  });

  it("text(), arrayBuffer(), blob() and formData() are waited for too", async () => {
    expect(await out.page("/text")).toBe("text:loaded");
    expect(await out.page("/buffer")).toBe("buffer:loaded");
    expect(await out.page("/blob")).toBe("blob:loaded");
    expect(await out.page("/form")).toBe("form:loaded");
  });

  it("a cloned response's body read is waited for", async () => {
    expect(await out.page("/clone")).toBe("clone:loaded");
  });

  it("a body read that rejects is released, and the app's own handler runs", async () => {
    // A leaked pending entry would hold the route until the 4 s timeout and
    // fail the whole run; reaching here with the handler's text proves both.
    expect(await out.page("/handled-failure")).toBe("failed-handled");
  });

  it("an unread body (here, one that never ends) does not hold the page", async () => {
    expect(await out.page("/unused-body")).toBe("headers:200");
    // Had the body been waited for, the route would have hit the 4 s timeout
    // and failed the run; its own render time shows it was not even close.
    const route = out.results.find((r) => r.route === "/unused-body");
    expect(route?.ms).toBeLessThan(4_000);
  });
});

describe("prerender error handling for body reads", () => {
  it("a body read that rejects with no handler fails the route", async () => {
    const error = await run(["/unhandled-failure"], "out-unhandled").then(
      () => null,
      (e: Error) => e,
    );
    // The body read's own error surfaces (undici: "TypeError: terminated"),
    // not a settle timeout: the rejection was neither swallowed nor leaked.
    expect(error?.message).toMatch(/unhandled-failure: TypeError/);
    expect(error?.message).not.toMatch(/did not settle/);
  }, 60_000);
});
