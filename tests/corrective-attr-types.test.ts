/**
 * Public TypeScript signatures must describe the runtime exactly.
 *
 * PR #56 made a reactive `null`/`undefined` REMOVE an attribute rather than
 * write the literal text "null". `bindAttrs`' declared type still excluded both,
 * so the documented behaviour was unreachable from type-checked code: the
 * extremely ordinary `() => string | null | undefined` getter was a compile
 * error, and callers had to cast to reach a supported path.
 *
 * These are compile-time assertions as much as runtime ones — the file is part
 * of `tsconfig.test.json`, so a signature regression fails `typecheck:tests`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { type AttributeSource, type AttributeValue, bindAttrs, bindData } from "../src/ui/reactiveAttr";

describe("bindAttrs — type surface matches runtime", () => {
  it("accepts null and undefined statically and reactively", () => {
    const maybeLabel: string | null | undefined = null;
    const el = document.createElement("div");
    el.setAttribute("title", "before");
    el.setAttribute("aria-label", "before");
    el.setAttribute("data-x", "before");

    bindAttrs(el, {
      title: null,
      "aria-label": () => maybeLabel,
      "data-x": undefined,
    });

    expect(el.hasAttribute("title")).toBe(false);
    expect(el.hasAttribute("aria-label")).toBe(false);
    expect(el.hasAttribute("data-x")).toBe(false);
  });

  it("still writes the string 'null' when that is the value", () => {
    const el = document.createElement("div");
    bindAttrs(el, { title: "null", "data-y": () => "null" });
    expect(el.getAttribute("title")).toBe("null");
    expect(el.getAttribute("data-y")).toBe("null");
  });

  it("keeps boolean HTML attribute semantics", () => {
    const input = document.createElement("input");
    bindAttrs(input, { required: true });
    expect(input.getAttribute("required")).toBe("");

    bindAttrs(input, { required: false });
    expect(input.hasAttribute("required")).toBe(false);
  });

  it("distinguishes false from null on an ordinary attribute", () => {
    const el = document.createElement("div");
    bindAttrs(el, { "data-a": false, "data-b": null });
    // `false` is boolean-attribute semantics (absent); `null` is removal.
    expect(el.hasAttribute("data-a")).toBe(false);
    expect(el.hasAttribute("data-b")).toBe(false);
  });

  it("exposes the shared value types", () => {
    expectTypeOf<AttributeValue>().toEqualTypeOf<string | number | boolean | null | undefined>();
    expectTypeOf<AttributeSource>().toMatchTypeOf<AttributeValue | (() => AttributeValue)>();
  });

  it("types bindAttrs as accepting every AttributeSource", () => {
    expectTypeOf(bindAttrs).parameter(1).toMatchTypeOf<Record<string, AttributeSource>>();
  });
});

describe("bindData — same removal semantics, same types", () => {
  it("removes the data-* attribute for null and undefined", () => {
    const el = document.createElement("div");
    el.setAttribute("data-k", "before");
    bindData(el, "k", null);
    expect(el.hasAttribute("data-k")).toBe(false);

    const el2 = document.createElement("div");
    el2.setAttribute("data-k", "before");
    bindData(el2, "k", () => undefined);
    expect(el2.hasAttribute("data-k")).toBe(false);
  });

  it("still writes ordinary values", () => {
    const el = document.createElement("div");
    bindData(el, "k", "v");
    expect(el.getAttribute("data-k")).toBe("v");

    const el2 = document.createElement("div");
    bindData(el2, "k", () => "w");
    expect(el2.getAttribute("data-k")).toBe("w");
  });
});

describe("bindAttribute — reactive removal (already shipped, pinned here)", () => {
  it("removes on null and undefined", () => {
    const el = document.createElement("div");
    el.setAttribute("title", "before");
    bindAttribute(el, "title", () => null);
    expect(el.hasAttribute("title")).toBe(false);
  });
});
