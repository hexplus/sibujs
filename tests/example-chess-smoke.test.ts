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
    // The graph really was walked: the island, the vendored engine and the
    // package's own entry points.
    expect(seen.size).toBeGreaterThan(3);
    expect([...seen].some((u) => u.endsWith("/vendor/chess.js"))).toBe(true);
    expect([...seen].some((u) => u.includes("/dist/index.js"))).toBe(true);
  }, 30_000);

  it("does not 404 on the vendored engine, whose build step is easy to forget", async () => {
    const res = await fetch(`${BASE}/examples/chess/vendor/chess.js`);
    expect(res.status).toBe(200);
    const source = await res.text();
    expect(source).toContain("chess.js@");
    expect(source.length).toBeGreaterThan(1000);
  });
});
