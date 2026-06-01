import { describe, expect, it } from "vitest";
import { isUnsafeKey, stripUnsafeKeys } from "../src/utils/guards";
import { isEventHandlerAttr, stripControlChars } from "../src/utils/sanitize";

describe("isUnsafeKey", () => {
  it("flags the three prototype-pollution keys", () => {
    expect(isUnsafeKey("__proto__")).toBe(true);
    expect(isUnsafeKey("constructor")).toBe(true);
    expect(isUnsafeKey("prototype")).toBe(true);
  });

  it("allows ordinary keys", () => {
    for (const k of ["proto", "__proto", "proto__", "Constructor", "name", "id", "value", ""]) {
      expect(isUnsafeKey(k)).toBe(false);
    }
  });
});

describe("stripUnsafeKeys", () => {
  it("removes prototype-pollution keys and keeps the rest", () => {
    // JSON.parse so __proto__ is an OWN enumerable key (the real attack shape).
    const raw = JSON.parse('{"a":1,"__proto__":{"polluted":true},"constructor":2,"prototype":3,"b":4}');
    const out = stripUnsafeKeys(raw);
    expect(out).toEqual({ a: 1, b: 4 });
    // Global prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns a fresh object (does not mutate the input)", () => {
    const raw = { a: 1 };
    const out = stripUnsafeKeys(raw);
    expect(out).not.toBe(raw);
    expect(out).toEqual({ a: 1 });
  });
});

describe("isEventHandlerAttr", () => {
  it("matches on* handlers case-insensitively", () => {
    for (const n of ["onclick", "onerror", "ONLOAD", "OnMouseOver", "onAbort", "on-load".replace("-", "")]) {
      expect(isEventHandlerAttr(n)).toBe(true);
    }
    expect(isEventHandlerAttr("onclick")).toBe(true);
    expect(isEventHandlerAttr("ONCLICK")).toBe(true);
  });

  it("does not match non-handler attributes", () => {
    for (const n of ["href", "class", "data-on", "one", "on", "o", "", "n", "data-onclick", "for"]) {
      // "one" has a letter after "on" -> matches by the spec-accurate rule; verify the genuinely-safe ones
      if (n === "one") continue;
      expect(isEventHandlerAttr(n)).toBe(false);
    }
  });

  it("requires an ASCII letter after `on` (so `on`, `on-x`, `on1` are not handlers)", () => {
    expect(isEventHandlerAttr("on")).toBe(false); // too short
    expect(isEventHandlerAttr("on-x")).toBe(false); // 3rd char not a letter
    expect(isEventHandlerAttr("on1")).toBe(false);
    expect(isEventHandlerAttr("onx")).toBe(true); // 3rd char is a letter
  });
});

describe("stripControlChars", () => {
  it("removes C0/C1 control chars and ASCII whitespace runs", () => {
    expect(stripControlChars("java\tscript:")).toBe("javascript:");
    expect(stripControlChars("\x01javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(stripControlChars("a\nb\rc d")).toBe("abcd");
    expect(stripControlChars("\x7f\x9f data:")).toBe("data:");
  });

  it("leaves ordinary text intact", () => {
    expect(stripControlChars("/foo/bar")).toBe("/foo/bar");
    expect(stripControlChars("https://x.com/path?q=1#h")).toBe("https://x.com/path?q=1#h");
  });
});
