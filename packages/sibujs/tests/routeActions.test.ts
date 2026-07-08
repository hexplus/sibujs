import { describe, expect, it, vi } from "vitest";
import { createAction } from "../src/platform/routeActions";

const _tick = () => new Promise((r) => setTimeout(r, 0));

describe("routeActions", () => {
  it("initializes with default state", () => {
    const action = createAction(async () => "result");

    expect(action.data()).toBe(undefined);
    expect(action.error()).toBe(undefined);
    expect(action.loading()).toBe(false);
  });

  it("sets loading to true during submission and stores result on success", async () => {
    const actionFn = vi.fn().mockImplementation(async (data: Record<string, unknown>) => {
      return { id: 1, name: data.name };
    });

    const action = createAction(actionFn);

    const promise = action.submit({ name: "Alice" });

    // loading should be true while in flight
    expect(action.loading()).toBe(true);

    const result = await promise;

    expect(result).toEqual({ id: 1, name: "Alice" });
    expect(action.data()).toEqual({ id: 1, name: "Alice" });
    expect(action.loading()).toBe(false);
    expect(action.error()).toBe(undefined);
  });

  it("captures error on failed submission", async () => {
    const actionFn = vi.fn().mockRejectedValue(new Error("Network error"));

    const action = createAction(actionFn);

    await expect(action.submit({ key: "value" })).rejects.toThrow("Network error");

    expect(action.error()?.message).toBe("Network error");
    expect(action.loading()).toBe(false);
    expect(action.data()).toBe(undefined);
  });

  it("clears previous error on new submission", async () => {
    let callCount = 0;
    const actionFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("First call fails");
      return "success";
    });

    const action = createAction(actionFn);

    // First call fails
    await expect(action.submit({})).rejects.toThrow("First call fails");
    expect(action.error()?.message).toBe("First call fails");

    // Second call succeeds and should clear the error
    await action.submit({});
    expect(action.error()).toBe(undefined);
    expect(action.data()).toBe("success");
  });

  it("passes FormData-like objects to the action function", async () => {
    const actionFn = vi.fn().mockResolvedValue("ok");
    const action = createAction(actionFn);

    const formData = { username: "bob", password: "secret" };
    await action.submit(formData);

    expect(actionFn).toHaveBeenCalledWith(formData);
  });
});
