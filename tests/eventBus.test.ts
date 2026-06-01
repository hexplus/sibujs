import { describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/ui/eventBus";

interface Events {
  message: string;
  tick: number;
  payload: { id: number };
}

describe("eventBus", () => {
  it("delivers emitted data to a registered handler", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    bus.on("message", handler);
    bus.emit("message", "hi");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("hi");
  });

  it("invokes every handler registered for the same event", () => {
    const bus = eventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();

    bus.on("tick", a);
    bus.on("tick", b);
    bus.on("tick", c);
    bus.emit("tick", 7);

    expect(a).toHaveBeenCalledWith(7);
    expect(b).toHaveBeenCalledWith(7);
    expect(c).toHaveBeenCalledWith(7);
  });

  it("does not deliver an event to handlers of a different event", () => {
    const bus = eventBus<Events>();
    const onMessage = vi.fn();
    const onTick = vi.fn();

    bus.on("message", onMessage);
    bus.on("tick", onTick);
    bus.emit("message", "only message");

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe function from on()", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    const unsub = bus.on("message", handler);
    expect(typeof unsub).toBe("function");

    bus.emit("message", "first");
    unsub();
    bus.emit("message", "second");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("first");
  });

  it("removes a handler via off()", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    bus.on("tick", handler);
    bus.emit("tick", 1);
    bus.off("tick", handler);
    bus.emit("tick", 2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });

  it("off() only removes the targeted handler, leaving others active", () => {
    const bus = eventBus<Events>();
    const keep = vi.fn();
    const remove = vi.fn();

    bus.on("tick", keep);
    bus.on("tick", remove);
    bus.off("tick", remove);
    bus.emit("tick", 99);

    expect(remove).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledWith(99);
  });

  it("off() on an event with no listeners is a no-op", () => {
    const bus = eventBus<Events>();
    expect(() => bus.off("tick", vi.fn())).not.toThrow();
  });

  it("off() with an unregistered handler does not affect existing handlers", () => {
    const bus = eventBus<Events>();
    const registered = vi.fn();

    bus.on("tick", registered);
    bus.off("tick", vi.fn());
    bus.emit("tick", 5);

    expect(registered).toHaveBeenCalledWith(5);
  });

  it("deduplicates the same handler reference (Set semantics)", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    bus.on("tick", handler);
    bus.on("tick", handler);
    bus.emit("tick", 3);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes object payloads by reference", () => {
    const bus = eventBus<Events>();
    const payload = { id: 42 };
    const handler = vi.fn();

    bus.on("payload", handler);
    bus.emit("payload", payload);

    expect(handler.mock.calls[0][0]).toBe(payload);
  });

  it("emit() with no handlers does not throw", () => {
    const bus = eventBus<Events>();
    expect(() => bus.emit("message", "nobody listening")).not.toThrow();
  });

  it("clear() removes all handlers across all events", () => {
    const bus = eventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();

    bus.on("message", a);
    bus.on("tick", b);
    bus.clear();
    bus.emit("message", "x");
    bus.emit("tick", 1);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("can re-register a handler after clear()", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    bus.on("message", handler);
    bus.clear();
    bus.on("message", handler);
    bus.emit("message", "again");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps separate listener registries per bus instance", () => {
    const bus1 = eventBus<Events>();
    const bus2 = eventBus<Events>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus1.on("tick", h1);
    bus2.on("tick", h2);
    bus1.emit("tick", 10);

    expect(h1).toHaveBeenCalledWith(10);
    expect(h2).not.toHaveBeenCalled();
  });

  it("calls a handler multiple times across repeated emits", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    bus.on("tick", handler);
    bus.emit("tick", 1);
    bus.emit("tick", 2);
    bus.emit("tick", 3);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(2, 2);
  });

  it("unsubscribe function is idempotent", () => {
    const bus = eventBus<Events>();
    const handler = vi.fn();

    const unsub = bus.on("tick", handler);
    unsub();
    expect(() => unsub()).not.toThrow();

    bus.emit("tick", 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
