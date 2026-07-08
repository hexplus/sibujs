// Regression tests for round-7 fixes (htm parser, scheduler, devtools).
import { describe, expect, it } from "vitest";
import { html } from "@sibujs/core";
import { formatError } from "../src/devtools/sourceMaps";
import { Priority, processInChunks, scheduleUpdate } from "../src/performance/scheduler";

describe("htm parser: unquoted attribute values with slashes", () => {
  it("keeps a full unquoted URL containing slashes", () => {
    const a = html`<a href=http://example.com/a/b>link</a>` as HTMLElement;
    expect(a.getAttribute("href")).toBe("http://example.com/a/b");
    expect(a.textContent).toBe("link");
  });

  it("keeps a leading-slash unquoted href", () => {
    const a = html`<a href=/foo/bar>link</a>` as HTMLElement;
    expect(a.getAttribute("href")).toBe("/foo/bar");
  });

  it("still self-closes a void element written as <br/>", () => {
    const d = html`<div><br/>x</div>` as HTMLElement;
    expect(d.querySelector("br")).not.toBeNull();
    expect(d.textContent).toContain("x");
  });
});

describe("htm parser: bare '<' and comments are not parsed as tags", () => {
  it("treats '<' followed by a space as literal text (no crash)", () => {
    const d = html`<div>a < b and c > d</div>` as HTMLElement;
    expect(d.tagName).toBe("DIV");
    expect(d.textContent).toContain("< b");
  });

  it("treats '<' followed by a digit as text", () => {
    const d = html`<div>I <3 SibuJS</div>` as HTMLElement;
    expect(d.textContent).toContain("<3");
  });

  it("skips HTML comments instead of crashing", () => {
    const d = html`<div>before<!-- hidden -->after</div>` as HTMLElement;
    expect(d.tagName).toBe("DIV");
    expect(d.textContent).toContain("before");
    expect(d.textContent).toContain("after");
    expect(d.textContent).not.toContain("hidden");
  });

  it("skips a doctype declaration", () => {
    expect(() => html`<!DOCTYPE html><div>x</div>`).not.toThrow();
  });
});

describe("scheduler: no priority inversion", () => {
  it("runs a USER_BLOCKING task even when a LOW task already armed a frame", async () => {
    const order: string[] = [];
    const realRaf = globalThis.requestAnimationFrame;
    // Frame never fires on its own — so a task stuck behind it would never run.
    globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame;
    try {
      scheduleUpdate(Priority.LOW, () => order.push("low"));
      scheduleUpdate(Priority.USER_BLOCKING, () => order.push("high"));
      await Promise.resolve();
      await Promise.resolve();
      // High-priority task re-armed at the microtask tier and ran.
      expect(order).toContain("high");
      expect(order[0]).toBe("high");
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});

describe("processInChunks: processes every item across chunk boundaries", () => {
  it("processes all items with a small chunk size", async () => {
    const seen: number[] = [];
    await processInChunks([0, 1, 2, 3, 4, 5, 6], (x) => seen.push(x), 2);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("formatError: cyclic cause chains", () => {
  it("does not overflow the stack on a cyclic cause", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as unknown as { cause: Error }).cause = b;
    (b as unknown as { cause: Error }).cause = a;
    expect(() => formatError(a)).not.toThrow();
  });
});

describe("debugValue: throwing formatter does not kill tracking", () => {
  it("falls back to an error label when the formatter throws", async () => {
    const { debugValue, getDebugValues } = await import("../src/devtools/debugValue");
    const { signal } = await import("@sibujs/core");
    const [n] = signal(0);
    const stop = debugValue(
      () => n(),
      () => {
        throw new Error("boom");
      },
    );
    const entry = getDebugValues().find((e) => e.label.includes("format error"));
    expect(entry).toBeDefined();
    stop();
  });
});
