import { describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import {
  DynamicComponent,
  registerComponent,
  resolveComponent,
  unregisterComponent,
} from "../src/core/rendering/dynamic";
import { signal } from "../src/core/signals/signal";

describe("dynamic coverage2 — registry", () => {
  it("registers and resolves a component by name", () => {
    registerComponent("Widget", () => {
      const el = document.createElement("div");
      el.className = "widget";
      return el;
    });
    const el = resolveComponent("Widget");
    expect(el.className).toBe("widget");
    unregisterComponent("Widget");
  });

  it("returns a fallback placeholder for an unknown component", () => {
    const el = resolveComponent("DoesNotExist");
    expect(el.textContent).toContain('Component "DoesNotExist" not found');
  });

  it("unregisterComponent removes the registration", () => {
    registerComponent("Temp", () => document.createElement("p"));
    unregisterComponent("Temp");
    const el = resolveComponent("Temp");
    expect(el.textContent).toContain("not found");
  });
});

describe("dynamic coverage2 — DynamicComponent", () => {
  it("renders a registered component by reactive name and swaps on change", () => {
    registerComponent("list", () => {
      const el = document.createElement("ul");
      el.className = "list-view";
      return el;
    });
    registerComponent("grid", () => {
      const el = document.createElement("div");
      el.className = "grid-view";
      return el;
    });
    const [view, setView] = signal("list");
    const container = DynamicComponent(() => view());
    expect(container.querySelector(".list-view")).not.toBeNull();
    setView("grid");
    expect(container.querySelector(".grid-view")).not.toBeNull();
    expect(container.querySelector(".list-view")).toBeNull();
    unregisterComponent("list");
    unregisterComponent("grid");
  });

  it("renders a component function returned directly", () => {
    const compA = () => {
      const el = document.createElement("section");
      el.className = "a";
      return el;
    };
    const compB = () => {
      const el = document.createElement("section");
      el.className = "b";
      return el;
    };
    const [comp, setComp] = signal(compA);
    const container = DynamicComponent(() => comp());
    expect(container.querySelector(".a")).not.toBeNull();
    setComp(() => compB);
    expect(container.querySelector(".b")).not.toBeNull();
    expect(container.querySelector(".a")).toBeNull();
  });

  it("disposes old content when swapping (cleanup runs)", () => {
    const cleanupSpy = vi.fn();
    const compWith = () => {
      const el = document.createElement("div");
      el.className = "with-cleanup";
      // register a disposer so swap triggers cleanup
      import("../src/core/rendering/dispose").then(({ registerDisposer }) => {
        registerDisposer(el, cleanupSpy);
      });
      return el;
    };
    // Use synchronous registerDisposer instead
    return import("../src/core/rendering/dispose").then(({ registerDisposer }) => {
      const compClean = () => {
        const el = document.createElement("div");
        el.className = "clean";
        registerDisposer(el, cleanupSpy);
        return el;
      };
      const compOther = () => {
        const el = document.createElement("div");
        el.className = "other";
        return el;
      };
      const [c, setC] = signal(compClean);
      const container = DynamicComponent(() => c());
      expect(container.querySelector(".clean")).not.toBeNull();
      setC(() => compOther);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      void compWith;
    });
  });

  it("disposing the container tears down the reactive effect", () => {
    let renders = 0;
    const [view, setView] = signal("x");
    registerComponent("x", () => {
      renders++;
      return document.createElement("div");
    });
    registerComponent("y", () => {
      renders++;
      return document.createElement("div");
    });
    const container = DynamicComponent(() => view());
    expect(renders).toBe(1);
    dispose(container);
    setView("y"); // effect disposed → no re-render
    expect(renders).toBe(1);
    unregisterComponent("x");
    unregisterComponent("y");
  });
});
