import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textSelection } from "../src/browser/textSelection";

describe("textSelection", () => {
  let handlers: Record<string, EventListener[]>;
  let selection: {
    rangeCount: number;
    isCollapsed: boolean;
    toString: () => string;
    getRangeAt: () => { getBoundingClientRect: () => DOMRect };
    removeAllRanges: () => void;
  };

  beforeEach(() => {
    handlers = {};
    selection = {
      rangeCount: 0,
      isCollapsed: true,
      toString: () => "",
      getRangeAt: () => ({
        getBoundingClientRect: () =>
          ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect,
      }),
      removeAllRanges: vi.fn(),
    };
    vi.stubGlobal("document", {
      getSelection: () => selection,
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        (handlers[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fire() {
    for (const h of handlers["selectionchange"] || []) h({} as Event);
  }

  it("starts with no selection", () => {
    const sel = textSelection();
    expect(sel.text()).toBe("");
    expect(sel.rect()).toBe(null);
    expect(sel.hasSelection()).toBe(false);
  });

  it("picks up a non-collapsed selection", () => {
    const sel = textSelection();
    selection.rangeCount = 1;
    selection.isCollapsed = false;
    selection.toString = () => "hello";
    selection.getRangeAt = () => ({
      getBoundingClientRect: () =>
        ({ x: 10, y: 20, width: 50, height: 15, top: 20, left: 10, right: 60, bottom: 35 }) as DOMRect,
    });
    fire();
    expect(sel.text()).toBe("hello");
    expect(sel.hasSelection()).toBe(true);
    expect(sel.rect()?.width).toBe(50);
  });

  it("clear() removes the selection via DOM API", () => {
    const sel = textSelection();
    sel.clear();
    expect(selection.removeAllRanges).toHaveBeenCalled();
    expect(sel.text()).toBe("");
  });

  it("dispose removes the selectionchange listener", () => {
    const sel = textSelection();
    sel.dispose();
    expect(handlers["selectionchange"]?.length ?? 0).toBe(0);
  });
});
