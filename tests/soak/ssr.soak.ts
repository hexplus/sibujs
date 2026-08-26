// SSR request soak — isolation and streaming under sustained load.
//
// Excluded from the fast suite; run with `npm run test:soak`.
//
// Prior passes proved request isolation for a handful of concurrent requests.
// This asserts the same invariant holds across tens of thousands of renders and
// under heavy interleaving, which is where a shared-state bug that survives a
// small test typically shows itself.
//
// The controlling invariant, per §40: every request carries a unique marker,
// and no request's output may ever contain another request's marker.
import { describe, expect, it } from "vitest";
import { getRequestScopedCache, runInSSRContext } from "../../src/core/ssr-context";
import { __resetQueryCache } from "../../src/data/query";
import { collectStream, renderToStream, renderToString, serializeState, ssrSuspense } from "../../src/platform/ssr";

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** Build a small tree stamped with one request's marker. */
function renderRequest(marker: string): string {
  const root = document.createElement("div");
  root.setAttribute("data-request", marker);
  const h = document.createElement("h1");
  h.textContent = `user ${marker}`;
  const p = document.createElement("p");
  p.textContent = `secret-${marker}`;
  root.append(h, p);
  return renderToString(root);
}

describe("SSR request soak", () => {
  it("10 000 sequential renders never leak another request's marker", () => {
    const outputs: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const marker = `req${i}`;
      const html = runInSSRContext(() => renderRequest(marker));
      expect(html, `request ${marker} did not render its own marker`).toContain(`secret-${marker}`);
      outputs.push(html);
    }

    // Spot-check for cross-contamination against a spread of other markers.
    // Checking all 10 000 against all 10 000 is quadratic and pointless; a
    // stride sample catches any systematic bleed.
    for (let i = 0; i < outputs.length; i += 97) {
      for (let j = 0; j < outputs.length; j += 997) {
        if (i === j) continue;
        expect(outputs[i], `request req${i} contains req${j}'s marker`).not.toContain(`secret-req${j}"`);
        expect(outputs[i].includes(`data-request="req${j}"`), `req${i} carries req${j}'s id`).toBe(false);
      }
    }
  });

  it("1 000 concurrent requests each get their own cache map", async () => {
    __resetQueryCache();

    // NOTE ON WHAT THIS DOES *NOT* TEST, and why.
    //
    // The obvious formulation — "run `query()` in each request and check nobody
    // sees anybody else's data" — is VACUOUS here: `query()` never fetches under
    // SSR, because its fetch is driven by an `effect()` and effects are
    // suppressed while the SSR flag is set. That is correct and deliberate
    // (server rendering must not kick off client data fetches; SSR data arrives
    // via loaders and `serializeState`), but it means every request reads
    // `undefined` and the cross-contamination filter has nothing to reject.
    // The first version of this test did exactly that and passed while proving
    // nothing. See rc-api-contract.md, "query() under SSR".
    //
    // What IS testable, and is the actual isolation mechanism, is that each
    // concurrently-running request resolves to its own cache map instance.
    const maps = await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        runInSSRContext(async () => {
          const before = getRequestScopedCache<unknown>("query");
          // Yield hard, so the 1 000 request scopes genuinely interleave rather
          // than running to completion one at a time.
          await new Promise((r) => setTimeout(r, 0));
          await flush(4);
          const after = getRequestScopedCache<unknown>("query");
          // The scope must survive an await — this is the AsyncLocalStorage
          // propagation guarantee the whole design rests on.
          expect(after, `request ${i} lost its scope across an await`).toBe(before);
          return after;
        }),
      ),
    );

    expect(
      maps.every((m) => m !== null),
      "a request resolved to the process-global cache",
    ).toBe(true);
    expect(new Set(maps).size, "concurrent requests shared a cache map instance").toBe(1_000);
  });

  it("1 000 concurrent requests do not share suspense id sequences", async () => {
    // `ssrSuspense` ids come from a per-request counter in the SSR store. If
    // that store were shared, ids would interleave across requests and the
    // client-side swap script would target another request's boundary. Each
    // request emits three boundaries, so each must see exactly 0, 1, 2.
    const idSets = await Promise.all(
      Array.from({ length: 1_000 }, () =>
        runInSSRContext(async () => {
          const ids: string[] = [];
          for (let n = 0; n < 3; n++) {
            const { element } = ssrSuspense({
              fallback: () => document.createElement("span"),
              content: () => Promise.resolve(document.createElement("b")),
            });
            ids.push(element.getAttribute("data-sibu-suspense-id") ?? "");
            await new Promise((r) => setTimeout(r, 0));
          }
          return ids;
        }),
      ),
    );

    for (const ids of idSets) {
      expect(ids, "suspense id counter bled across concurrent requests").toEqual([
        "sibu-sus-0",
        "sibu-sus-1",
        "sibu-sus-2",
      ]);
    }
  });

  it("10 000 serializeState calls keep each request's payload separate", () => {
    for (let i = 0; i < 10_000; i++) {
      const marker = `s${i}`;
      const html = runInSSRContext(() => serializeState({ token: `tok-${marker}` }));
      expect(html).toContain(`tok-${marker}`);
      if (i > 0) expect(html).not.toContain(`tok-s${i - 1}"`);
    }
  });

  it("2 000 stream start/consume/complete cycles retain no request state", async () => {
    for (let i = 0; i < 2_000; i++) {
      const marker = `st${i}`;
      const root = document.createElement("div");
      root.textContent = `stream-${marker}`;
      const out = await runInSSRContext(() => collectStream(renderToStream(root)));
      expect(out).toContain(`stream-${marker}`);
      if (i > 0) expect(out).not.toContain(`stream-st${i - 1}<`);
    }
  });

  it("500 streams abandoned mid-consumption do not wedge later requests", async () => {
    for (let i = 0; i < 500; i++) {
      const root = document.createElement("div");
      for (let c = 0; c < 10; c++) {
        const span = document.createElement("span");
        span.textContent = `chunk${c}`;
        root.appendChild(span);
      }
      // Take one chunk and walk away — the generator is never driven to
      // completion, which is what an aborted HTTP response looks like.
      const stream = runInSSRContext(() => renderToStream(root));
      await stream.next();
      await stream.return?.(undefined as never);
    }

    // A clean request afterwards must be entirely unaffected.
    const root = document.createElement("div");
    root.textContent = "after-abandonment";
    const out = await runInSSRContext(() => collectStream(renderToStream(root)));
    expect(out).toContain("after-abandonment");
  });
});
