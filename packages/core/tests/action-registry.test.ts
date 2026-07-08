import { beforeEach, describe, expect, test, vi } from "vitest";
import { type ActionFn, action, clickOutside, getAction, registerAction } from "../src/core/rendering/action";

describe("action registry", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("registers and retrieves an action by name", () => {
    const fn: ActionFn<number> = () => undefined;
    registerAction("custom:test", fn);
    expect(getAction<number>("custom:test")).toBe(fn);
  });

  test("getAction returns undefined for an unknown name", () => {
    expect(getAction("custom:does-not-exist")).toBeUndefined();
  });

  test("built-in actions are discoverable by name", () => {
    expect(getAction("clickOutside")).toBe(clickOutside);
  });

  test("a registered action can be applied by name via action() and cleans up on dispose", () => {
    const cleanup = vi.fn();
    const run = vi.fn();
    const myAction: ActionFn<string> = (el, param) => {
      run(el, param);
      return cleanup;
    };
    registerAction("custom:apply", myAction);

    const el = document.createElement("div");
    action(el, "custom:apply", "hello");

    expect(run).toHaveBeenCalledWith(el, "hello");
    // Disposing the element runs the action's cleanup (registerDisposer wiring).
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("applying an unregistered name throws a clear error", () => {
    const el = document.createElement("div");
    expect(() => action(el, "custom:missing", 1)).toThrow(/action/i);
  });
});
