import { describe, expect, it, vi } from "vitest";
import { createMicroApp, createSharedScope } from "../src/platform/microfrontend";

// ---------------------------------------------------------------------------
// createMicroApp
// ---------------------------------------------------------------------------
describe("createMicroApp", () => {
  describe("basic creation", () => {
    it("should create a micro-app with a data attribute", () => {
      const app = createMicroApp({ name: "test-widget" });
      expect(app.element.getAttribute("data-micro-app")).toBe("test-widget");
    });

    it("should create its own container element when none is provided", () => {
      const app = createMicroApp({ name: "auto" });
      expect(app.element).toBeInstanceOf(HTMLElement);
      expect(app.element.tagName).toBe("DIV");
    });

    it("should use the provided container element", () => {
      const container = document.createElement("section");
      const app = createMicroApp({ name: "custom", container });
      expect(app.element).toBe(container);
      expect(container.getAttribute("data-micro-app")).toBe("custom");
    });
  });

  describe("mount", () => {
    it("should render a component inside the container", () => {
      const app = createMicroApp({ name: "m1" });
      document.body.appendChild(app.element);

      app.mount(() => {
        const el = document.createElement("span");
        el.textContent = "Hello";
        return el;
      });

      expect(app.element.querySelector("span")?.textContent).toBe("Hello");
      document.body.removeChild(app.element);
    });

    it("should replace previous content on re-mount", () => {
      const app = createMicroApp({ name: "m2" });

      app.mount(() => {
        const el = document.createElement("div");
        el.className = "first";
        return el;
      });
      expect(app.element.querySelector(".first")).not.toBeNull();

      app.mount(() => {
        const el = document.createElement("div");
        el.className = "second";
        return el;
      });
      expect(app.element.querySelector(".first")).toBeNull();
      expect(app.element.querySelector(".second")).not.toBeNull();
    });
  });

  describe("unmount", () => {
    it("should remove all children on unmount", () => {
      const app = createMicroApp({ name: "m3" });

      app.mount(() => {
        const el = document.createElement("p");
        el.textContent = "content";
        return el;
      });
      expect(app.element.childNodes.length).toBeGreaterThan(0);

      app.unmount();
      expect(app.element.childNodes.length).toBe(0);
    });

    it("should be safe to call unmount before mount", () => {
      const app = createMicroApp({ name: "m4" });
      expect(() => app.unmount()).not.toThrow();
    });

    it("should be safe to call unmount multiple times", () => {
      const app = createMicroApp({ name: "m5" });
      app.mount(() => document.createElement("div"));
      app.unmount();
      expect(() => app.unmount()).not.toThrow();
      expect(app.element.childNodes.length).toBe(0);
    });
  });

  describe("shadow DOM isolation", () => {
    it("should use shadow DOM when shadow option is true", () => {
      const app = createMicroApp({ name: "shadow-app", shadow: true });

      app.mount(() => {
        const el = document.createElement("div");
        el.textContent = "shadowed";
        return el;
      });

      const shadowRoot = app.element.shadowRoot;
      expect(shadowRoot).not.toBeNull();
      expect(shadowRoot?.querySelector("div")?.textContent).toBe("shadowed");

      // The light DOM host should not contain the child directly
      expect(app.element.querySelector("div")).toBeNull();
    });

    it("should unmount shadow DOM content", () => {
      const app = createMicroApp({ name: "shadow-unmount", shadow: true });

      app.mount(() => document.createElement("span"));
      expect(app.element.shadowRoot?.childNodes.length).toBeGreaterThan(0);

      app.unmount();
      expect(app.element.shadowRoot?.childNodes.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// createSharedScope
// ---------------------------------------------------------------------------
describe("createSharedScope", () => {
  describe("get / set", () => {
    it("should return initial values", () => {
      const scope = createSharedScope({ count: 0, name: "Alice" });
      expect(scope.get("count")).toBe(0);
      expect(scope.get("name")).toBe("Alice");
    });

    it("should update values via set", () => {
      const scope = createSharedScope({ count: 0 });
      scope.set("count", 42);
      expect(scope.get("count")).toBe(42);
    });

    it("should support multiple keys independently", () => {
      const scope = createSharedScope({ a: 1, b: 2 });
      scope.set("a", 10);
      expect(scope.get("a")).toBe(10);
      expect(scope.get("b")).toBe(2);
    });

    it("should handle object values", () => {
      const scope = createSharedScope<{ user: { name: string } | null }>({
        user: null,
      });
      scope.set("user", { name: "Bob" });
      expect(scope.get("user")).toEqual({ name: "Bob" });
    });
  });

  describe("subscribe", () => {
    it("should notify subscribers when a value changes", () => {
      const scope = createSharedScope({ theme: "light" as string });
      const callback = vi.fn();

      scope.subscribe("theme", callback);
      scope.set("theme", "dark");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("dark");
    });

    it("should not notify subscribers for other keys", () => {
      const scope = createSharedScope({ a: 1, b: 2 });
      const callbackA = vi.fn();

      scope.subscribe("a", callbackA);
      scope.set("b", 99);

      expect(callbackA).not.toHaveBeenCalled();
    });

    it("should support multiple subscribers on the same key", () => {
      const scope = createSharedScope({ value: 0 });
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      scope.subscribe("value", cb1);
      scope.subscribe("value", cb2);
      scope.set("value", 5);

      expect(cb1).toHaveBeenCalledWith(5);
      expect(cb2).toHaveBeenCalledWith(5);
    });

    it("should stop notifying after unsubscribe", () => {
      const scope = createSharedScope({ count: 0 });
      const callback = vi.fn();

      const unsub = scope.subscribe("count", callback);
      scope.set("count", 1);
      expect(callback).toHaveBeenCalledTimes(1);

      unsub();
      scope.set("count", 2);
      expect(callback).toHaveBeenCalledTimes(1); // not called again
    });

    it("should handle subscribe-unsubscribe-subscribe correctly", () => {
      const scope = createSharedScope({ x: 0 });
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = scope.subscribe("x", cb1);
      scope.set("x", 1);
      expect(cb1).toHaveBeenCalledTimes(1);

      unsub1();
      scope.subscribe("x", cb2);
      scope.set("x", 2);

      expect(cb1).toHaveBeenCalledTimes(1); // still 1
      expect(cb2).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledWith(2);
    });

    it("should notify with each successive set call", () => {
      const scope = createSharedScope({ n: 0 });
      const values: number[] = [];

      scope.subscribe("n", (v) => values.push(v));
      scope.set("n", 1);
      scope.set("n", 2);
      scope.set("n", 3);

      expect(values).toEqual([1, 2, 3]);
    });
  });

  describe("lazy key creation", () => {
    it("should lazily create signals for keys not in initial state", () => {
      const scope = createSharedScope<{ extra?: string }>({});
      expect(scope.get("extra")).toBeUndefined();

      scope.set("extra", "hello");
      expect(scope.get("extra")).toBe("hello");
    });

    it("should support subscribing to lazily created keys", () => {
      const scope = createSharedScope<{ late?: number }>({});
      const callback = vi.fn();

      scope.subscribe("late", callback);
      scope.set("late", 42);

      expect(callback).toHaveBeenCalledWith(42);
    });
  });
});
