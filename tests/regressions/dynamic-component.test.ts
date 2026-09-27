import { describe, expect, it, vi } from "vitest";
import { DynamicComponent, registerComponent, unregisterComponent } from "../../src/core/rendering/dynamic";
import { signal } from "../../src/core/signals/signal";

describe("DynamicComponent rebuilds only when is() changes", () => {
  it("regression: a signal read eagerly in the component body does not remount it", () => {
    const [count, setCount] = signal(0);
    let builds = 0;
    const Counter = () => {
      builds++;
      const el = document.createElement("div");
      el.textContent = String(count());
      return el;
    };

    const container = DynamicComponent(() => Counter);
    const first = container.firstElementChild;
    expect(builds).toBe(1);

    setCount(1);
    expect(builds).toBe(1);
    expect(container.firstElementChild).toBe(first);
  });

  it("regression: typed input survives a write to a signal the component read", () => {
    const [label, setLabel] = signal("Name");
    const Form = () => {
      const wrap = document.createElement("label");
      wrap.append(label(), document.createElement("input"));
      return wrap;
    };

    const container = DynamicComponent(() => Form);
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "half-typed";

    setLabel("Full name");
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("half-typed");
  });

  it("regression: re-running is() with the same registered name keeps the instance", () => {
    const [view, setView] = signal("panel");
    const [tick, setTick] = signal(0);
    let builds = 0;
    registerComponent("panel", () => {
      builds++;
      return document.createElement("section");
    });

    // `is()` reads `tick`, so the effect re-runs, but the name it returns does not change.
    const container = DynamicComponent(() => {
      tick();
      return view();
    });
    const first = container.firstElementChild;
    setTick(1);
    expect(builds).toBe(1);
    expect(container.firstElementChild).toBe(first);

    setView("missing");
    expect(container.textContent).toContain("not found");
    unregisterComponent("panel");
  });

  it("regression: a name registered after the first render replaces the 'not found' placeholder", () => {
    const container = DynamicComponent(() => "late-widget");
    expect(container.textContent).toContain("not found");

    registerComponent("late-widget", () => {
      const el = document.createElement("section");
      el.className = "late";
      return el;
    });
    expect(container.querySelector(".late")).not.toBeNull();
    expect(container.textContent).not.toContain("not found");

    unregisterComponent("late-widget");
    expect(container.textContent).toContain("not found");
  });

  it("regression: a component that threw is built again on the next run", () => {
    const [view, setView] = signal<"good" | "flaky">("good");
    const [tick, setTick] = signal(0);
    let fail = true;
    const Good = () => document.createElement("p");
    const Flaky = () => {
      if (fail) throw new Error("transient");
      const el = document.createElement("div");
      el.className = "flaky";
      return el;
    };

    // `is()` reads `tick`, so a write re-runs the switch with the same target.
    const container = DynamicComponent(() => {
      tick();
      return view() === "good" ? Good : Flaky;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      try {
        setView("flaky");
      } catch {
        // Where an effect's error surfaces is not what this test is about.
      }
      expect(container.querySelector(".flaky")).toBeNull();

      fail = false;
      try {
        setTick(1);
      } catch {
        // See above.
      }
      expect(container.querySelector(".flaky")).not.toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});
