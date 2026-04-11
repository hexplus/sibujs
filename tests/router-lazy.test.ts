import { describe, expect, it } from "vitest";
import { createRouter, navigate } from "../src/plugins/router";

function pageModule(label: string) {
  return async () => ({
    default: () => {
      const el = document.createElement("div");
      el.textContent = label;
      return el;
    },
  });
}

describe("router / lazy shorthand", () => {
  it("accepts `{ lazy }` on a route and resolves like `{ component: lazy(...) }`", async () => {
    createRouter([
      { path: "/", component: () => document.createElement("div") },
      { path: "/page", lazy: pageModule("Page A") },
    ]);
    const result = await navigate("/page");
    expect(result.success).toBe(true);
  });

  it("walks nested children with the shorthand", async () => {
    createRouter([
      {
        path: "/",
        component: () => document.createElement("div"),
        children: [{ path: "/nested", lazy: pageModule("Nested") }],
      },
    ]);
    const result = await navigate("/nested");
    expect(result.success).toBe(true);
  });
});
