import { describe, expect, it } from "vitest";
import { Portal } from "../src/core/rendering/portal";

describe("Portal", () => {
  it("should return a comment anchor", () => {
    const anchor = Portal(() => document.createElement("div"));
    expect(anchor).toBeInstanceOf(Comment);
  });

  it("should render nodes into target container", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    const child = document.createElement("span");
    child.textContent = "Portal content";

    Portal(() => child, target);

    await new Promise((r) => setTimeout(r, 10));

    expect(target.contains(child)).toBe(true);
    expect(target.textContent).toBe("Portal content");

    document.body.removeChild(target);
  });
});
