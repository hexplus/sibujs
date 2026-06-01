import { afterEach, describe, expect, it, vi } from "vitest";
import { textSelection } from "../src/browser/textSelection";

function fakeSelection(opts: {
  rangeCount?: number;
  isCollapsed?: boolean;
  text?: string;
  rect?: { width: number; height: number } | null;
  throwOnRange?: boolean;
}) {
  return {
    rangeCount: opts.rangeCount ?? 1,
    isCollapsed: opts.isCollapsed ?? false,
    removeAllRanges: vi.fn(),
    toString: () => opts.text ?? "",
    getRangeAt: () => {
      if (opts.throwOnRange) throw new Error("no range");
      return {
        getBoundingClientRect: () => opts.rect ?? { width: 0, height: 0 },
      };
    },
  };
}

describe("textSelection (coverage2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("degrades when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    const sel = textSelection();
    expect(sel.text()).toBe("");
    expect(sel.rect()).toBe(null);
    expect(sel.hasSelection()).toBe(false);
    expect(() => {
      sel.clear();
      sel.dispose();
    }).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("clears state when selection is null", () => {
    vi.spyOn(document, "getSelection").mockReturnValue(null);
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.text()).toBe("");
    expect(sel.rect()).toBe(null);
    expect(sel.hasSelection()).toBe(false);
  });

  it("clears state when selection is collapsed or has no ranges", () => {
    vi.spyOn(document, "getSelection").mockReturnValue(fakeSelection({ rangeCount: 0 }) as unknown as Selection);
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.text()).toBe("");

    vi.spyOn(document, "getSelection").mockReturnValue(
      fakeSelection({ isCollapsed: true, text: "x" }) as unknown as Selection,
    );
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.text()).toBe("");
  });

  it("captures text and rect for a real selection", () => {
    vi.spyOn(document, "getSelection").mockReturnValue(
      fakeSelection({ text: "hello", rect: { width: 100, height: 20 } }) as unknown as Selection,
    );
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.text()).toBe("hello");
    expect(sel.hasSelection()).toBe(true);
    expect(sel.rect()).toEqual({ width: 100, height: 20 });
  });

  it("sets rect to null when the range has zero size", () => {
    vi.spyOn(document, "getSelection").mockReturnValue(
      fakeSelection({ text: "abc", rect: { width: 0, height: 0 } }) as unknown as Selection,
    );
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.text()).toBe("abc");
    expect(sel.rect()).toBe(null);
  });

  it("sets rect to null when getRangeAt throws", () => {
    vi.spyOn(document, "getSelection").mockReturnValue(
      fakeSelection({ text: "abc", throwOnRange: true }) as unknown as Selection,
    );
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.rect()).toBe(null);
  });

  it("clear() removes ranges and resets state", () => {
    const fake = fakeSelection({ text: "hello", rect: { width: 10, height: 10 } });
    vi.spyOn(document, "getSelection").mockReturnValue(fake as unknown as Selection);
    const sel = textSelection();
    document.dispatchEvent(new Event("selectionchange"));
    expect(sel.hasSelection()).toBe(true);

    sel.clear();
    expect(fake.removeAllRanges).toHaveBeenCalled();
    expect(sel.text()).toBe("");
    expect(sel.rect()).toBe(null);
  });

  it("dispose removes the selectionchange listener", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const sel = textSelection();
    sel.dispose();
    expect(removeSpy).toHaveBeenCalledWith("selectionchange", expect.any(Function));
  });
});
