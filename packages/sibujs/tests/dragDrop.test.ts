import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draggable, dropZone } from "../src/browser/dragDrop";

describe("draggable", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets element as draggable", () => {
    const el = document.createElement("div");
    draggable(() => el, { id: 1 });
    expect(el.draggable).toBe(true);
  });

  it("tracks isDragging state on dragstart and dragend", () => {
    const el = document.createElement("div");
    const { isDragging } = draggable(() => el, { id: 1 });

    expect(isDragging()).toBe(false);

    const dragStartEvent = new Event("dragstart") as DragEvent;
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: { setData: vi.fn() },
    });
    el.dispatchEvent(dragStartEvent);
    expect(isDragging()).toBe(true);

    el.dispatchEvent(new Event("dragend"));
    expect(isDragging()).toBe(false);
  });

  it("serializes data to dataTransfer on dragstart", () => {
    const el = document.createElement("div");
    const data = { id: 42, name: "test" };
    draggable(() => el, data);

    const setDataSpy = vi.fn();
    const dragStartEvent = new Event("dragstart") as DragEvent;
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: { setData: setDataSpy },
    });
    el.dispatchEvent(dragStartEvent);

    expect(setDataSpy).toHaveBeenCalledWith("application/json", JSON.stringify(data));
  });

  it("cleans up on dispose", () => {
    const el = document.createElement("div");
    const removeListenerSpy = vi.spyOn(el, "removeEventListener");

    const { dispose } = draggable(() => el);
    dispose();

    expect(removeListenerSpy).toHaveBeenCalledWith("dragstart", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("dragend", expect.any(Function));
  });
});

describe("dropZone", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tracks isOver state on dragenter and dragleave", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    const { isOver } = dropZone(() => el, { onDrop });

    expect(isOver()).toBe(false);

    const enterEvent = new Event("dragenter") as DragEvent;
    Object.defineProperty(enterEvent, "preventDefault", { value: vi.fn() });
    el.dispatchEvent(enterEvent);
    expect(isOver()).toBe(true);

    el.dispatchEvent(new Event("dragleave"));
    expect(isOver()).toBe(false);
  });

  it("calls onDrop with parsed data on drop", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    dropZone(() => el, { onDrop });

    const dropEvent = new Event("drop") as DragEvent;
    Object.defineProperty(dropEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: vi.fn(() => JSON.stringify({ id: 42 })) },
    });
    el.dispatchEvent(dropEvent);

    expect(onDrop).toHaveBeenCalledWith({ id: 42 }, dropEvent);
  });

  it("sets isOver to false on drop", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    const { isOver } = dropZone(() => el, { onDrop });

    // First enter
    const enterEvent = new Event("dragenter") as DragEvent;
    Object.defineProperty(enterEvent, "preventDefault", { value: vi.fn() });
    el.dispatchEvent(enterEvent);
    expect(isOver()).toBe(true);

    // Then drop
    const dropEvent = new Event("drop") as DragEvent;
    Object.defineProperty(dropEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: vi.fn(() => "") },
    });
    el.dispatchEvent(dropEvent);

    expect(isOver()).toBe(false);
  });

  it("cleans up on dispose", () => {
    const el = document.createElement("div");
    const removeListenerSpy = vi.spyOn(el, "removeEventListener");
    const onDrop = vi.fn();

    const { dispose } = dropZone(() => el, { onDrop });
    dispose();

    expect(removeListenerSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("dragenter", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("dragleave", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("drop", expect.any(Function));
  });
});
