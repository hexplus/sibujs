import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard } from "../src/browser/clipboard";

describe("clipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(() => Promise.resolve()),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns empty text initially", () => {
    const { text, copied } = clipboard();
    expect(text()).toBe("");
    expect(copied()).toBe(false);
  });

  it("copies text to clipboard and updates state", async () => {
    const { text, copy, copied } = clipboard();

    await copy("hello world");
    expect(text()).toBe("hello world");
    expect(copied()).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello world");
  });

  it("resets copied to false after 2 seconds", async () => {
    const { copy, copied } = clipboard();

    await copy("test");
    expect(copied()).toBe(true);

    vi.advanceTimersByTime(1999);
    expect(copied()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(copied()).toBe(false);
  });

  it("resets timer on successive copies", async () => {
    const { copy, copied } = clipboard();

    await copy("first");
    vi.advanceTimersByTime(1500);
    expect(copied()).toBe(true);

    await copy("second");
    vi.advanceTimersByTime(1500);
    expect(copied()).toBe(true); // timer was reset

    vi.advanceTimersByTime(500);
    expect(copied()).toBe(false); // 2s since second copy
  });

  it("does not throw when clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { copy, text } = clipboard();

    await copy("test");
    expect(text()).toBe(""); // not updated since API unavailable
  });
});
