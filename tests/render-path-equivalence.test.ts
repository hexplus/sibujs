/**
 * Render-path equivalence.
 *
 * `renderToString()` and `renderToStream()` are two documented ways to produce
 * the same SSR output. They diverged in practice (ST-001: the streaming path
 * omitted the `data-sibu-ssr` provenance marker), and the pre-existing test
 * that claimed to check this only used `toContain`, so it never compared them.
 *
 * These tests compare the two paths byte-for-byte across the element shapes
 * that historically differed, so the paths cannot silently drift apart again.
 */
import { describe, expect, it } from "vitest";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";

const bothPathsAgree = async (node: Node) => {
  const streamed = await collectStream(renderToStream(node));
  expect(streamed).toBe(renderToString(node));
  return streamed;
};

describe("render-path equivalence: renderToString ≡ renderToStream", () => {
  it("agrees on a void element", async () => {
    const html = await bothPathsAgree(document.createElement("br"));
    expect(html).toContain("data-sibu-ssr");
  });

  it("agrees on a simple element with attributes", async () => {
    const el = document.createElement("div");
    el.className = "wrap";
    el.id = "root";
    el.textContent = "child";
    await bothPathsAgree(el);
  });

  it("agrees on a nested tree", async () => {
    const outer = document.createElement("section");
    const inner = document.createElement("span");
    inner.textContent = "deep";
    outer.appendChild(inner);
    outer.appendChild(document.createElement("hr"));
    await bothPathsAgree(outer);
  });

  it("agrees on hostile text that must be escaped", async () => {
    const el = document.createElement("p");
    el.textContent = "<script>alert(1)</script> & \"quotes\" 'single'";
    const html = await bothPathsAgree(el);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("agrees on comments and text nodes in a fragment", async () => {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createComment("c --> x"));
    frag.appendChild(document.createTextNode("<txt>"));
    frag.appendChild(document.createElement("br"));
    await bothPathsAgree(frag);
  });

  it("agrees on an element carrying data-sibu-hydrate (marker suppressed)", async () => {
    const el = document.createElement("div");
    el.setAttribute("data-sibu-hydrate", "true");
    const html = await bothPathsAgree(el);
    // The provenance marker is intentionally omitted for hydrate-marked nodes.
    expect(html).not.toContain("data-sibu-ssr");
  });
});
