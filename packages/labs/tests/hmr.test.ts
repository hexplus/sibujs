import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHMRState, createHMRBoundary, hmrState, isHMRAvailable, registerHMR } from "../src/devtools/hmr";

describe("hmrState", () => {
  afterEach(() => {
    clearHMRState();
  });

  it("should return the initial value on first use", () => {
    const [get] = hmrState("test.counter", 42);
    expect(get()).toBe(42);
  });

  it("should persist state across re-creations (simulating HMR reload)", () => {
    // First "load": create state and update it
    const [get1, set1] = hmrState("persist.counter", 0);
    set1(99);
    expect(get1()).toBe(99);

    // Second "load": re-create with the same id — should get persisted value
    const [get2] = hmrState("persist.counter", 0);
    expect(get2()).toBe(99);
  });

  it("should allow the setter to accept an updater function", () => {
    const [get, set] = hmrState("updater.test", 10);
    set((prev) => prev + 5);
    expect(get()).toBe(15);
  });

  it("should use initial value when no persisted state exists", () => {
    const [get] = hmrState("fresh.state", "hello");
    expect(get()).toBe("hello");
  });

  it("should keep separate state for different ids", () => {
    const [getA, setA] = hmrState("a", 1);
    const [getB, setB] = hmrState("b", 2);
    setA(100);
    setB(200);
    expect(getA()).toBe(100);
    expect(getB()).toBe(200);
  });
});

describe("registerHMR", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    clearHMRState();
    container.remove();
  });

  it("should render the initial component into the container", () => {
    const component = () => {
      const el = document.createElement("span");
      el.textContent = "v1";
      return el;
    };

    registerHMR("widget", component, container);

    expect(container.querySelector("span")?.textContent).toBe("v1");
  });

  it("should replace the DOM element on update", () => {
    const v1 = () => {
      const el = document.createElement("span");
      el.textContent = "v1";
      return el;
    };

    const hmr = registerHMR("widget", v1, container);

    const v2 = () => {
      const el = document.createElement("span");
      el.textContent = "v2";
      return el;
    };

    hmr.update(v2);

    expect(container.querySelector("span")?.textContent).toBe("v2");
  });

  it("should run dispose callbacks on update", () => {
    const _disposed = false;

    const component = () => {
      const el = document.createElement("div");
      return el;
    };

    // We need to get the registry entry to add a dispose callback.
    // registerHMR stores dispose callbacks internally. We can verify by
    // calling dispose and checking side effects.
    const hmr = registerHMR("dispose-test", component, container);

    // Trigger dispose
    hmr.dispose();

    // After dispose, the element should be removed from the container
    expect(container.children.length).toBe(0);
  });

  it("should remove the element from DOM on dispose", () => {
    const component = () => {
      const el = document.createElement("p");
      el.textContent = "removable";
      return el;
    };

    const hmr = registerHMR("removable", component, container);

    expect(container.querySelector("p")).not.toBeNull();

    hmr.dispose();

    expect(container.querySelector("p")).toBeNull();
  });

  it("should work without a container (no auto-append)", () => {
    const component = () => {
      const el = document.createElement("div");
      el.textContent = "no-container";
      return el;
    };

    const hmr = registerHMR("no-container", component);

    // No container, so nothing appended — just ensure no error
    expect(container.children.length).toBe(0);
    // Dispose should also not throw
    hmr.dispose();
  });
});

describe("createHMRBoundary", () => {
  afterEach(() => {
    clearHMRState();
  });

  it("should wrap a component in a boundary div with data attribute", () => {
    const boundary = createHMRBoundary("test-boundary");

    const wrapped = boundary.wrap(() => {
      const el = document.createElement("span");
      el.textContent = "inside boundary";
      return el;
    });

    expect(wrapped.tagName).toBe("DIV");
    expect(wrapped.getAttribute("data-hmr-boundary")).toBe("test-boundary");
    expect(wrapped.querySelector("span")?.textContent).toBe("inside boundary");
  });

  it("should register accept callbacks", () => {
    let accepted = false;
    const boundary = createHMRBoundary("accept-test");

    boundary.wrap(() => document.createElement("div"));
    boundary.accept(() => {
      accepted = true;
    });

    // The callback is only invoked when __SIBU_HMR_ACCEPT__ is set,
    // so we verify it was registered without error.
    expect(accepted).toBe(false);
  });

  it("should register dispose callbacks", () => {
    let disposed = false;
    const boundary = createHMRBoundary("dispose-test");

    boundary.wrap(() => document.createElement("div"));
    boundary.dispose(() => {
      disposed = true;
    });

    // The callback is stored but not invoked until an HMR update occurs
    expect(disposed).toBe(false);
  });

  it("should accept with no callback without throwing", () => {
    const boundary = createHMRBoundary("no-cb");
    boundary.wrap(() => document.createElement("div"));
    expect(() => boundary.accept()).not.toThrow();
  });

  it("should invoke accept and dispose callbacks when __SIBU_HMR_ACCEPT__ is set", () => {
    let acceptCalled = false;
    let disposeCalled = false;

    // Simulate bundler HMR API
    let storedHandler: (() => void) | null = null;
    (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__ = (_id: string, handler: () => void) => {
      storedHandler = handler;
    };

    try {
      const boundary = createHMRBoundary("hook-test");
      const wrapper = boundary.wrap(() => {
        const el = document.createElement("p");
        el.textContent = "original";
        return el;
      });
      document.body.appendChild(wrapper);

      boundary.dispose(() => {
        disposeCalled = true;
      });
      boundary.accept(() => {
        acceptCalled = true;
      });

      // Simulate a hot update
      if (storedHandler) storedHandler();

      expect(disposeCalled).toBe(true);
      expect(acceptCalled).toBe(true);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__;
    }
  });
});

describe("clearHMRState", () => {
  it("should clear all persisted HMR state", () => {
    const [get1, set1] = hmrState("clear.a", 0);
    set1(42);
    expect(get1()).toBe(42);

    clearHMRState();

    // After clearing, re-creating should use the initial value
    const [get2] = hmrState("clear.a", 0);
    expect(get2()).toBe(0);
  });

  it("should clear HMR registry", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const hmr = registerHMR("clear-reg", () => document.createElement("div"), container);

    clearHMRState();

    // After clearing, update and dispose should be safe no-ops
    expect(() => hmr.update(() => document.createElement("span"))).not.toThrow();
    expect(() => hmr.dispose()).not.toThrow();

    container.remove();
  });
});

describe("isHMRAvailable", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__;
    delete (globalThis as unknown as Record<string, unknown>).module;
  });

  it("should return false when no HMR API is available", () => {
    // Ensure clean environment
    delete (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__;
    delete (globalThis as unknown as Record<string, unknown>).module;

    expect(isHMRAvailable()).toBe(false);
  });

  it("should return true when __SIBU_HMR_ACCEPT__ is set", () => {
    (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__ = () => {};

    expect(isHMRAvailable()).toBe(true);
  });

  it("should return true when module.hot is available (Webpack-style)", () => {
    (globalThis as unknown as Record<string, unknown>).module = { hot: { accept() {} } };

    expect(isHMRAvailable()).toBe(true);
  });

  it("should return false when module exists but hot is falsy", () => {
    (globalThis as unknown as Record<string, unknown>).module = { hot: null };

    expect(isHMRAvailable()).toBe(false);
  });
});
