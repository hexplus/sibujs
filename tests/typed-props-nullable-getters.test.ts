/**
 * A typed attribute getter may resolve to `null` / `undefined`.
 *
 * The runtime has removed an attribute whose getter resolves to `null` or
 * `undefined` since 4.5, and AGENTS.md §4 documents it — but the typed factory
 * props declared `reactive<T>` (`T | (() => T)`), so the documented getter
 *
 *   img({ width: () => (cur() ? String(cur()!.width) : null) })
 *
 * failed with TS2345. Every attribute where removal is meaningful now accepts a
 * getter returning `null | undefined`. The IDL properties (`value`, `checked`,
 * `selected`, `disabled`) keep their types: they are DOM state, not optional
 * attributes.
 *
 * Compile-time assertions as much as runtime ones: this file is part of
 * `tsconfig.test.json`, so a regression fails `typecheck:tests`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { a, button, div, form, img, input, label, option, select, textarea, video } from "../src/core/rendering/html";
import type { ImgProps, InputProps } from "../src/core/rendering/tagPropTypes";
import { signal } from "../src/core/signals/signal";

describe("typed props accept getters that resolve to null", () => {
  it("removes img width/height when the getter resolves to null", () => {
    const [cur, setCur] = signal<{ width: number } | null>({ width: 640 });
    const el = img({
      src: "/a.png",
      alt: "",
      width: () => (cur() ? String(cur()?.width) : null),
      height: () => (cur() ? 480 : undefined),
    });
    expect(el.getAttribute("width")).toBe("640");
    expect(el.getAttribute("height")).toBe("480");
    setCur(null);
    expect(el.hasAttribute("width")).toBe(false);
    expect(el.hasAttribute("height")).toBe(false);
  });

  it("type-checks nullable getters across the typed factories", () => {
    const [on] = signal(false);
    const maybe = (v: string) => () => (on() ? v : null);
    a({ href: maybe("/x"), target: maybe("_blank"), rel: () => undefined, download: () => null });
    input({ placeholder: maybe("p"), min: () => null, maxlength: () => (on() ? 3 : null), required: () => null });
    button({ type: () => (on() ? "submit" : null), formaction: maybe("/go") });
    form({ action: maybe("/f"), method: () => null });
    select({ name: maybe("n"), size: () => undefined });
    textarea({ rows: () => (on() ? 3 : null), placeholder: maybe("t") });
    label({ for: maybe("id") });
    option({ label: maybe("l") });
    video({ poster: maybe("/p.png"), width: () => null, autoplay: () => undefined });
    div({ id: () => (on() ? "x" : null) });
    expect(true).toBe(true);
  });

  it("keeps the IDL properties' types", () => {
    // @ts-expect-error — `value` is DOM state; a getter must produce a value.
    input({ value: () => null });
    // @ts-expect-error — `checked` is DOM state.
    input({ checked: () => null });
    // @ts-expect-error — `selected` is DOM state.
    option({ selected: () => undefined });
    // @ts-expect-error — `disabled` is DOM state.
    button({ disabled: () => null });
    expect(true).toBe(true);
  });

  it("exposes the widened shape on the prop interfaces", () => {
    expectTypeOf<() => string | null>().toMatchTypeOf<NonNullable<ImgProps["width"]>>();
    expectTypeOf<() => undefined>().toMatchTypeOf<NonNullable<InputProps["placeholder"]>>();
    expectTypeOf<() => string | null>().not.toMatchTypeOf<NonNullable<InputProps["value"]>>();
  });
});
