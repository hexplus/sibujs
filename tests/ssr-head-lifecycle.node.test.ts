// @vitest-environment node
//
// The head lifecycle on the built-in server DOM (no jsdom registered): the same
// scenarios as `ssr-head-lifecycle.test.ts`, same results.

import { describe, expect, it } from "vitest";
import { renderQueryBackedHead, renderTemporaryBranch } from "./ssr-head-lifecycle.cases";

describe("server Head() on the built-in server DOM", () => {
  it("withdraws a removed branch's title and noindex", async () => {
    expect(typeof window).toBe("undefined");
    const r = await renderTemporaryBranch();
    expect(r.html).toContain("final body");
    expect(r.head).toContain("<title>Page</title>");
    expect(r.head).toContain('content="Outer description"');
    expect(r.head).not.toContain("noindex");
    expect(r.noindex).toBe(false);
  });

  it("renders query-backed head values with the loaded data", async () => {
    const r = await renderQueryBackedHead();
    expect(r.head).toContain("<title>Loaded title</title>");
    expect(r.head).toContain('<meta name="description" content="About Loaded title" />');
    expect(r.head).toContain('<meta property="og:title" content="Loaded title" />');
  });
});
