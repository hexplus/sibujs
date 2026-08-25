/**
 * Documented runtime limits.
 *
 * These tests do not assert that SibuJS is unbounded — they pin the boundaries
 * the framework actually commits to, so a future change that silently narrows
 * one is caught. See docs/architecture/reactivity.md ("Known limits").
 */
import { describe, expect, it } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";

describe("documented limits: derived chain depth", () => {
  // `derived()` evaluates lazily and pull-based, so reading the tail of a chain
  // of length N costs N stack frames. Chains of ~1 000 are comfortably
  // supported; the ceiling (~2 000-3 000, host- and call-context dependent) is
  // the JS stack itself, not SibuJS bookkeeping. Real apps nest tens deep.
  it("supports a derived chain 1000 links deep", () => {
    const [source, setSource] = signal(0);
    let node: () => number = source;
    for (let i = 0; i < 1000; i++) {
      const prev = node;
      node = derived(() => prev() + 1);
    }

    expect(node()).toBe(1000);
    setSource(1);
    expect(node()).toBe(1001);
  });
});

describe("documented limits: DOM disposal depth", () => {
  // dispose() walks the tree iteratively (explicit stack, not recursion), so
  // unlike derived chains its depth is bounded by memory rather than the JS
  // stack — a deeply nested component tree tears down without overflowing.
  it("disposes a 2000-deep DOM tree without overflowing the stack", () => {
    const root = document.createElement("div");
    let cursor: HTMLElement = root;
    let disposed = 0;

    for (let i = 0; i < 2000; i++) {
      const child = document.createElement("div");
      registerDisposer(child, () => {
        disposed++;
      });
      cursor.appendChild(child);
      cursor = child;
    }

    expect(() => dispose(root)).not.toThrow();
    expect(disposed).toBe(2000);
  });
});
