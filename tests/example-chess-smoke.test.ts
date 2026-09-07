import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Deployment smoke test for the chess reference example.
//
// A reference application that does not LOAD is worse than none: the failure
// shows up as "site not found" or a blank page long after the commit that
// caused it. So this does not inspect files on disk — it serves the example the
// way it is actually served and walks the module graph the browser would walk,
// asserting every URL answers 200 with content.
//
// Requires `npm run build` (for `dist/`) and `npm run example:chess:build`
// (for the vendored engine) — the same precondition as consumption.test.ts.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");
const PORT = 5177;
const BASE = `http://127.0.0.1:${PORT}`;

const distBuilt = existsSync(resolve(ROOT, "dist/index.js"));
const vendorBuilt = existsSync(resolve(ROOT, "examples/chess/vendor/chess.js"));

let server: ChildProcess | undefined;

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/examples/chess/`);
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`example server never became ready: ${String(lastError)}`);
}

beforeAll(async () => {
  if (!distBuilt || !vendorBuilt) return;
  server = spawn(process.execPath, [resolve(ROOT, "tests-browser/server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitForServer();
}, 30_000);

afterAll(() => {
  server?.kill();
});

/** Every `from "…"` / bare `import "…"` specifier in an ES module. */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:^|[\s;}])(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']/g)) {
    out.push(m[1]);
  }
  for (const m of source.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

describe.skipIf(!distBuilt || !vendorBuilt)("chess example — production output is servable", () => {
  it("serves the directory URL as the example page", async () => {
    // The classic deployment failure: `/examples/chess/` resolving to a
    // directory and answering 404.
    const res = await fetch(`${BASE}/examples/chess/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain('data-sibu-island="chess"');
    // Two boards, 64 server-rendered squares each — present before any script runs.
    expect(html.match(/data-square="/g) ?? []).toHaveLength(128);
    expect(html).toContain('<script type="module" src="./chess-island.js">');
  });

  it("serves every asset the page references", async () => {
    const html = await (await fetch(`${BASE}/examples/chess/`)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(1);

    for (const ref of refs) {
      const res = await fetch(new URL(ref, `${BASE}/examples/chess/`));
      expect(res.status, `${ref} must be servable`).toBe(200);
      expect((await res.text()).length, `${ref} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("every module in the island's import graph resolves and loads", async () => {
    const entry = new URL("/examples/chess/chess-island.js", BASE).href;
    const seen = new Set<string>();
    const queue = [entry];
    const failures: string[] = [];

    while (queue.length > 0) {
      const url = queue.pop() as string;
      if (seen.has(url)) continue;
      seen.add(url);

      const res = await fetch(url);
      if (!res.ok) {
        failures.push(`${url} → ${res.status}`);
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("javascript")) {
        failures.push(`${url} → served as ${type}, which a browser will refuse to execute as a module`);
        continue;
      }
      const source = await res.text();
      for (const spec of moduleSpecifiers(source)) {
        // A bare specifier would need an import map the example does not ship.
        if (!spec.startsWith(".") && !spec.startsWith("/")) {
          failures.push(`${url} imports the bare specifier "${spec}"`);
          continue;
        }
        queue.push(new URL(spec, url).href);
      }
    }

    expect(failures).toEqual([]);
    // The graph really was walked: the island and the vendored engine.
    expect(seen.size).toBeGreaterThan(1);
    expect([...seen].some((u) => u.endsWith("/vendor/chess.js"))).toBe(true);

    // And the framework is NOT in it. The example takes SibuJS from the
    // <script> tag in index.html, so its module graph is the island plus the
    // engine and nothing else. An import of `../../dist/*` reappearing here
    // would mean the example silently needs `npm run build` again — a build
    // step in the one demo whose whole subject is that islands need none.
    expect([...seen].some((u) => u.includes("/dist/"))).toBe(false);
  }, 30_000);

  /**
   * The `src` of every CLASSIC script in a document, in source order.
   *
   * Attribute-level, not substring: `html.indexOf("cdn.global.js")` matched the
   * explanatory HTML comment above the tag and reported a passing test while
   * the page loaded a different artifact entirely. A filename mentioned in
   * prose can no longer satisfy anything here.
   *
   * Module scripts are excluded so the runtime tag and the island can be told
   * apart, and so `type="module"` written on the CDN tag would fail rather than
   * quietly change its loading semantics.
   */
  function classicScriptSources(html: string): string[] {
    return [...html.matchAll(/<script\b([^>]*)>/gi)]
      .filter((match) => !/\btype\s*=\s*["']module["']/i.test(match[1]))
      .map((match) => match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1])
      .filter((src): src is string => src !== undefined);
  }

  /** The index of the first script tag whose `src` is exactly `src`. */
  function scriptTagIndex(html: string, src: string): number {
    for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
      const attr = match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      if (attr === src) return match.index ?? -1;
    }
    return -1;
  }

  const FULL_CDN_SRC = "https://unpkg.com/sibujs@latest/dist/cdn.full.global.js";
  const CORE_CDN_SRC = "https://unpkg.com/sibujs@latest/dist/cdn.global.js";

  it("loads the FULL runtime bundle from a real script tag, not the core-only one", async () => {
    const html = await (await fetch(`${BASE}/examples/chess/index.html`)).text();
    const sources = classicScriptSources(html);

    // The island destructures `machine`, which lives in the patterns half of
    // the library. The core-only bundle would install `Sibu` and leave
    // `machine` undefined — a failure well away from the tag that caused it.
    expect(sources, `classic scripts were: ${JSON.stringify(sources)}`).toContain(FULL_CDN_SRC);
    expect(sources).not.toContain(CORE_CDN_SRC);
  }, 30_000);

  it("puts the runtime tag ahead of the deferred island module", async () => {
    const html = await (await fetch(`${BASE}/examples/chess/index.html`)).text();

    // Positions of the real TAGS, not of filename substrings found anywhere.
    const runtime = scriptTagIndex(html, FULL_CDN_SRC);
    const island = scriptTagIndex(html, "./chess-island.js");

    expect(runtime, "no classic script loads the full CDN bundle").toBeGreaterThan(-1);
    expect(island, "no module script loads the island").toBeGreaterThan(-1);
    // The island is a module and therefore deferred, so a classic script
    // anywhere in the document beats it — but ordering them the way a reader
    // would write them keeps the example honest.
    expect(runtime).toBeLessThan(island);
  }, 30_000);

  it("tells a reader who is missing the runtime to load the FULL bundle", async () => {
    // The guard throws when `globalThis.Sibu` is absent. Naming the core-only
    // bundle there sends the reader to a file that installs `Sibu` and still
    // leaves `machine` undefined, so the error would be followed by a second,
    // stranger failure.
    const source = await (await fetch(`${BASE}/examples/chess/chess-island.js`)).text();

    // Scoped to the throw, so an explanatory comment elsewhere cannot satisfy
    // it: everything between `new Error(` and its closing paren.
    const thrown = source.slice(source.indexOf("new Error("), source.indexOf("chess example] SibuJS") + 400);
    expect(thrown).toContain("cdn.full.global.js");
    expect(thrown.replace(/cdn\.full\.global\.js/g, "")).not.toContain("cdn.global.js");
  }, 30_000);

  it("does not 404 on the vendored engine, whose build step is easy to forget", async () => {
    const res = await fetch(`${BASE}/examples/chess/vendor/chess.js`);
    expect(res.status).toBe(200);
    const source = await res.text();
    expect(source).toContain("chess.js@");
    expect(source.length).toBeGreaterThan(1000);
  });
});
