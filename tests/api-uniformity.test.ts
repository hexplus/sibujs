/**
 * Signature uniformity across the rendering API.
 *
 * Two inconsistencies cost real debugging time because the wrong shape was
 * accepted without complaint, or accepted and then ignored:
 *
 *  - Tag factories honour a reactive (function) `class`; `RouterLink` read it
 *    with `typeof classAttr === "string"`, so a function fell through to `""`
 *    and the attribute was simply never written. No error, no class.
 *  - `show(cond, element)` takes an element while `when(cond, () => el)` takes
 *    thunks. Passing the wrong shape produced an obscure `TypeError` from deep
 *    inside the directive rather than a message naming the mistake.
 *
 * Both are widened here — every form accepted everywhere — with a dev warning
 * only where a shape is genuinely ambiguous rather than merely unusual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { show, when } from "../src/core/rendering/directives";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, RouterLink, setRoutes } from "../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const stub = (label: string) => () => {
  const d = document.createElement("div");
  d.textContent = label;
  return d;
};

describe("RouterLink honours a reactive class", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/docs", component: stub("docs") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
  });

  it("writes the class produced by a function", async () => {
    await settle();
    const link = RouterLink({ to: "/docs", class: () => "btn primary" }, "Docs");
    expect(link.className).toContain("btn");
    expect(link.className).toContain("primary");
  });

  it("updates the class when the signal it reads changes", async () => {
    await settle();
    const [theme, setTheme] = signal("light");
    const link = RouterLink({ to: "/docs", class: () => `btn ${theme()}` }, "Docs");
    expect(link.className).toContain("light");

    setTheme("dark");
    await settle();
    expect(link.className).toContain("dark");
    expect(link.className).not.toContain("light");
  });

  it("keeps the reactive class alongside the router's active classes", async () => {
    await settle();
    const link = RouterLink({ to: "/", class: () => "btn", activeClass: "on" }, "Home");
    await settle();
    expect(link.className).toContain("btn");
    expect(link.className).toContain("on");
  });

  it("still accepts a plain string class", async () => {
    await settle();
    const link = RouterLink({ to: "/docs", class: "btn" }, "Docs");
    expect(link.className).toContain("btn");
  });
});

describe("show() and when() accept both an element and a thunk", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("show() accepts a thunk and toggles the element it returns", () => {
    const [visible, setVisible] = signal(true);
    const el = show(
      () => visible(),
      () => span("hi"),
    ) as HTMLElement;
    expect(el.tagName).toBe("SPAN");
    expect(el.style.display).toBe("");

    setVisible(false);
    expect(el.style.display).toBe("none");
  });

  it("show() still accepts a bare element", () => {
    const [visible, setVisible] = signal(true);
    const el = show(() => visible(), span("hi"));
    expect(el.tagName).toBe("SPAN");
    setVisible(false);
    expect((el as HTMLElement).style.display).toBe("none");
  });

  it("when() accepts bare elements for its branches", async () => {
    const [flag, setFlag] = signal(true);
    const host = div([when(() => flag(), span("yes"), span("no"))]);
    document.body.appendChild(host);
    await Promise.resolve();

    expect(host.textContent).toContain("yes");
    setFlag(false);
    await Promise.resolve();
    expect(host.textContent).toContain("no");
    host.remove();
  });

  it("when() still accepts thunks", async () => {
    const [flag, setFlag] = signal(true);
    const host = div([
      when(
        () => flag(),
        () => span("yes"),
        () => span("no"),
      ),
    ]);
    document.body.appendChild(host);
    await Promise.resolve();
    expect(host.textContent).toContain("yes");
    setFlag(false);
    await Promise.resolve();
    expect(host.textContent).toContain("no");
    host.remove();
  });

  it("warns in dev when when() is given an element that a rebuild will reuse", async () => {
    // A bare element branch cannot be re-created, so toggling away and back
    // re-attaches the SAME node — with whatever state it accumulated. That is
    // usually fine and sometimes surprising, so it is a warning, not an error.
    const [flag, setFlag] = signal(true);
    const host = div([when(() => flag(), span("yes"), span("no"))]);
    document.body.appendChild(host);
    await Promise.resolve();
    setFlag(false);
    await Promise.resolve();
    setFlag(true);
    await Promise.resolve();

    const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("branch was given as an element");
    host.remove();
  });
});
