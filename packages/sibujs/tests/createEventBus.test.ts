import { describe, expect, it, vi } from "vitest";
import { eventBus } from "../src/ui/eventBus";

interface TestEvents {
  greet: string;
  count: number;
  data: { x: number; y: number };
}

describe("eventBus", () => {
  it("emits events to registered handlers", () => {
    const bus = eventBus<TestEvents>();
    const handler = vi.fn();

    bus.on("greet", handler);
    bus.emit("greet", "hello");

    expect(handler).toHaveBeenCalledWith("hello");
  });

  it("supports multiple handlers for same event", () => {
    const bus = eventBus<TestEvents>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on("count", handler1);
    bus.on("count", handler2);
    bus.emit("count", 42);

    expect(handler1).toHaveBeenCalledWith(42);
    expect(handler2).toHaveBeenCalledWith(42);
  });

  it("unsubscribes via returned function", () => {
    const bus = eventBus<TestEvents>();
    const handler = vi.fn();

    const unsub = bus.on("greet", handler);
    bus.emit("greet", "first");
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.emit("greet", "second");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes via off method", () => {
    const bus = eventBus<TestEvents>();
    const handler = vi.fn();

    bus.on("data", handler);
    bus.emit("data", { x: 1, y: 2 });
    expect(handler).toHaveBeenCalledTimes(1);

    bus.off("data", handler);
    bus.emit("data", { x: 3, y: 4 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clears all handlers", () => {
    const bus = eventBus<TestEvents>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("greet", h1);
    bus.on("count", h2);

    bus.clear();

    bus.emit("greet", "nope");
    bus.emit("count", 0);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("does not throw when emitting with no handlers", () => {
    const bus = eventBus<TestEvents>();
    expect(() => bus.emit("greet", "hello")).not.toThrow();
  });
});
