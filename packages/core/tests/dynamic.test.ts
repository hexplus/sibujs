import { describe, expect, it } from "vitest";
import { registerComponent, resolveComponent, unregisterComponent } from "../src/core/rendering/dynamic";

describe("dynamic component loading", () => {
  it("should register and resolve components", () => {
    const MyWidget = () => {
      const el = document.createElement("div");
      el.textContent = "Widget";
      return el;
    };

    registerComponent("widget", MyWidget);
    const el = resolveComponent("widget");
    expect(el.textContent).toBe("Widget");

    unregisterComponent("widget");
  });

  it("should return fallback for unregistered components", () => {
    const el = resolveComponent("nonexistent");
    expect(el.textContent).toContain("not found");
  });
});
