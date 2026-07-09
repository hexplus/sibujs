import { signal } from "@sibujs/core";
import { describe, expect, it, vi } from "vitest";
import { draggable, dropZone } from "../src/browser/dragDrop";

describe("draggable (coverage2)", () => {
  it("degrades when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const { isDragging, dispose } = draggable(() => document.createElement("div"), { a: 1 });
    expect(isDragging()).toBe(false);
    expect(() => dispose()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("accepts a ref-style target object", () => {
    const el = document.createElement("div");
    const { isDragging } = draggable({ current: el }, { id: 7 });
    expect(el.draggable).toBe(true);
    expect(isDragging()).toBe(false);
  });

  it("does not setData when data is undefined", () => {
    const el = document.createElement("div");
    draggable(() => el);
    const setDataSpy = vi.fn();
    const ev = new Event("dragstart") as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: { setData: setDataSpy } });
    el.dispatchEvent(ev);
    expect(setDataSpy).not.toHaveBeenCalled();
  });

  it("does not throw when dataTransfer is missing on dragstart", () => {
    const el = document.createElement("div");
    const { isDragging } = draggable(() => el, { id: 1 });
    const ev = new Event("dragstart") as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: null });
    el.dispatchEvent(ev);
    expect(isDragging()).toBe(true);
  });

  it("removes previous listeners when the reactive target changes", () => {
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    const remove1 = vi.spyOn(el1, "removeEventListener");
    const [target, setTarget] = signal<HTMLElement | null>(el1);
    draggable(() => target());
    expect(el1.draggable).toBe(true);

    setTarget(el2); // effect re-run removes el1 listeners, attaches el2
    expect(remove1).toHaveBeenCalledWith("dragstart", expect.any(Function));
    expect(remove1).toHaveBeenCalledWith("dragend", expect.any(Function));
    expect(el2.draggable).toBe(true);
  });

  it("handles null target gracefully (no listeners attached)", () => {
    const [target] = signal<HTMLElement | null>(null);
    const { isDragging, dispose } = draggable(() => target());
    expect(isDragging()).toBe(false);
    expect(() => dispose()).not.toThrow();
  });
});

describe("dropZone (coverage2)", () => {
  it("degrades when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const { isOver, dispose } = dropZone(() => document.createElement("div"), { onDrop: vi.fn() });
    expect(isOver()).toBe(false);
    expect(() => dispose()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("dragover calls preventDefault", () => {
    const el = document.createElement("div");
    dropZone(() => el, { onDrop: vi.fn() });
    const ev = new Event("dragover") as DragEvent;
    const pd = vi.fn();
    Object.defineProperty(ev, "preventDefault", { value: pd });
    el.dispatchEvent(ev);
    expect(pd).toHaveBeenCalled();
  });

  it("passes null when drop has no dataTransfer", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    dropZone(() => el, { onDrop });
    const ev = new Event("drop") as DragEvent;
    Object.defineProperty(ev, "preventDefault", { value: vi.fn() });
    Object.defineProperty(ev, "dataTransfer", { value: null });
    el.dispatchEvent(ev);
    expect(onDrop).toHaveBeenCalledWith(null, ev);
  });

  it("falls back to raw string when JSON.parse throws", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    dropZone(() => el, { onDrop });
    const ev = new Event("drop") as DragEvent;
    Object.defineProperty(ev, "preventDefault", { value: vi.fn() });
    Object.defineProperty(ev, "dataTransfer", {
      value: { getData: () => "not-json{{{" },
    });
    el.dispatchEvent(ev);
    expect(onDrop).toHaveBeenCalledWith("not-json{{{", ev);
  });

  it("strips prototype-pollution keys via the JSON reviver", () => {
    const el = document.createElement("div");
    const onDrop = vi.fn();
    dropZone(() => el, { onDrop });
    const ev = new Event("drop") as DragEvent;
    Object.defineProperty(ev, "preventDefault", { value: vi.fn() });
    Object.defineProperty(ev, "dataTransfer", {
      value: { getData: () => '{"a":1,"__proto__":{"polluted":true},"constructor":2,"prototype":3}' },
    });
    el.dispatchEvent(ev);
    const received = onDrop.mock.calls[0][0] as Record<string, unknown>;
    expect(received.a).toBe(1);
    // The reviver returns undefined for these keys, so they are not own props.
    expect(Object.hasOwn(received, "__proto__")).toBe(false);
    expect(Object.hasOwn(received, "constructor")).toBe(false);
    expect(Object.hasOwn(received, "prototype")).toBe(false);
    // Prototype chain was not polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("removes previous listeners when the reactive target changes", () => {
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    const remove1 = vi.spyOn(el1, "removeEventListener");
    const [target, setTarget] = signal<HTMLElement | null>(el1);
    dropZone(() => target(), { onDrop: vi.fn() });
    setTarget(el2);
    expect(remove1).toHaveBeenCalledWith("dragover", expect.any(Function));
    expect(remove1).toHaveBeenCalledWith("drop", expect.any(Function));
  });

  it("handles null target gracefully", () => {
    const [target] = signal<HTMLElement | null>(null);
    const { isOver, dispose } = dropZone(() => target(), { onDrop: vi.fn() });
    expect(isOver()).toBe(false);
    expect(() => dispose()).not.toThrow();
  });
});
