import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { DynamicComponent, registerComponent, unregisterComponent } from "../../src/core/rendering/dynamic";
import { div, span } from "../../src/core/rendering/html";
import { Portal } from "../../src/core/rendering/portal";
import type { Component } from "../../src/core/rendering/types";
import { signal } from "../../src/core/signals/signal";

// A factory that throws after allocating (a reactive element, a registered
// cleanup) releases what it registered: its half-built nodes were never
// returned, so no owner's disposal could reach them later.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
  unregisterComponent("rollback-bad");
});

interface Stats {
  runs: number;
  cleanups: number;
}

/** Allocate a reactive element and a cleanup, as a half-built view would. */
function allocate(value: () => number, stats: Stats): HTMLElement {
  const el = div(() => {
    stats.runs++;
    return String(value());
  });
  registerDisposer(el, () => stats.cleanups++);
  return el;
}

/** Collect what reaches the runtime error handler. */
function captureErrors(): unknown[] {
  const errors: unknown[] = [];
  setRuntimeErrorHandler((err) => {
    errors.push(err);
  });
  return errors;
}

describe("Portal with a throwing factory", () => {
  it("rolls back the bindings and cleanups the factory allocated", async () => {
    const errors = captureErrors();
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    const anchor = Portal(() => {
      allocate(value, stats);
      span(() => {
        stats.runs++;
        return String(value());
      });
      throw new Error("portal fail");
    }, target);
    document.body.append(anchor);
    await tick();
    expect(errors).toHaveLength(1);
    expect(stats.cleanups).toBe(1);
    expect(target.textContent).toBe("");
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    dispose(anchor);
    expect(stats.cleanups).toBe(1);
    setValue(2);
    expect(stats.runs).toBe(before);
  });

  it("rolls back nested builds that succeeded before the throw", async () => {
    captureErrors();
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    const Inner: Component = () => div([allocate(value, stats), allocate(value, stats)]);
    const anchor = Portal(() => {
      Inner();
      throw new Error("portal fail");
    }, target);
    document.body.append(anchor);
    await tick();
    expect(stats.cleanups).toBe(2);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("leaves a successful factory's content live until the anchor is disposed", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    const anchor = Portal(() => allocate(value, stats), target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("0");
    setValue(1);
    expect(target.textContent).toBe("1");
    expect(stats.cleanups).toBe(0);
    dispose(anchor);
    expect(stats.cleanups).toBe(1);
    expect(target.textContent).toBe("");
    const before = stats.runs;
    setValue(2);
    expect(stats.runs).toBe(before);
  });
});

describe("DynamicComponent with a throwing component", () => {
  it("rolls back a failed replacement and keeps the current view", () => {
    const errors = captureErrors();
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const Good: Component = () => div("good");
    const Bad: Component = () => {
      allocate(value, stats);
      throw new Error("bad component");
    };
    const [view, setView] = signal<Component>(Good);
    const root = DynamicComponent(view);
    document.body.append(root);
    setView(() => Bad);
    expect(errors).toHaveLength(1);
    expect(root.textContent).toBe("good");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    dispose(root);
    expect(stats.cleanups).toBe(1);
    setValue(2);
    expect(stats.runs).toBe(before);
  });

  it("renders a valid replacement after a failed one", () => {
    captureErrors();
    const [value] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const Good: Component = () => div("good");
    const Bad: Component = () => {
      allocate(value, stats);
      throw new Error("bad component");
    };
    const Other: Component = () => span("other");
    const [view, setView] = signal<Component>(Good);
    const root = DynamicComponent(view);
    document.body.append(root);
    setView(() => Bad);
    setView(() => Other);
    expect(root.textContent).toBe("other");
    // A component that failed is built again when shown again.
    setView(() => Bad);
    expect(root.textContent).toBe("other");
    expect(stats.cleanups).toBe(2);
  });

  it("rolls back a failed registered component resolved by name", () => {
    captureErrors();
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    registerComponent("rollback-bad", () => {
      allocate(value, stats);
      throw new Error("bad component");
    });
    const [name, setName] = signal("missing");
    const root = DynamicComponent(name);
    document.body.append(root);
    setName("rollback-bad");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("rolls back a component that fails on the first render", () => {
    const errors = captureErrors();
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const Bad: Component = () => {
      allocate(value, stats);
      throw new Error("bad component");
    };
    let root: HTMLDivElement | undefined;
    try {
      root = DynamicComponent(() => Bad);
    } catch (err) {
      errors.push(err);
    }
    expect(errors).toHaveLength(1);
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    if (root) dispose(root);
  });

  it("keeps a successful component live until the container is disposed", () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const root = DynamicComponent(() => () => allocate(value, stats));
    document.body.append(root);
    expect(root.textContent).toBe("0");
    setValue(1);
    expect(root.textContent).toBe("1");
    dispose(root);
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(2);
    expect(stats.runs).toBe(before);
  });
});
