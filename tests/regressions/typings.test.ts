/**
 * Public typings describe what the runtime actually produces and accepts.
 *
 * Reported: "Typings are loose. Components return plain Element and some
 * properties can't accept live values, which forced casts."
 *
 * Invariants under test:
 *  - Every tag factory returns its specific element type (`div()` is an
 *    `HTMLDivElement`, `svg()` an `SVGSVGElement`), so no cast is needed to
 *    reach element-specific members.
 *  - One public `Component` type, and every API that takes a component or a
 *    component's root (`mount`, `onMount`, `onUnmount`, `lazy`, `Suspense`,
 *    `Portal`, `defineComponent`, the HOC helpers) accepts what the factories
 *    return — including SVG roots wherever an `Element` is all the API needs.
 *  - `id` accepts a getter and binds it reactively; before, the getter was
 *    stringified into the element's id as its own function source.
 *  - `ref<HTMLInputElement>()` fits the `ref` prop under `strict`.
 *  - `on` handlers may declare the specific event type (`KeyboardEvent`).
 *  - A `class` getter may return `undefined` / `null` / `false` and renders no
 *    class.
 *  - `input({ type })` and `a({ target })` accept getters.
 *
 * This file is part of `tsconfig.test.json`, so every call below is also a
 * compile-time assertion: a signature regression fails `typecheck:tests`
 * (none of these calls use a cast or a `@ts-expect-error`).
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  a,
  type Component,
  circle,
  div,
  input,
  lazy,
  mount,
  onMount,
  onUnmount,
  Portal,
  ref,
  Suspense,
  signal,
  span,
  svg,
  tagFactory,
} from "../../index";
import { defineComponent, withDefaults, withProps, withWrapper } from "../../patterns";
import type { Component as RouterComponent } from "../../plugins";
import { dispose } from "../../src/core/rendering/dispose";
import { defineRemoteComponent } from "../../ssr";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("regression: tag factories return their specific element type", () => {
  it("regression: div() is an HTMLDivElement with no cast", () => {
    const el = div("hi");
    expectTypeOf(el).toEqualTypeOf<HTMLDivElement>();
    // Element-specific / HTMLElement-only members are reachable directly.
    el.style.color = "red";
    el.focus();
    expect(el).toBeInstanceOf(HTMLDivElement);
    expect(el.style.color).toBe("red");
  });

  it("regression: other HTML factories map to HTMLElementTagNameMap", () => {
    expectTypeOf(span()).toEqualTypeOf<HTMLSpanElement>();
    expectTypeOf(input()).toEqualTypeOf<HTMLInputElement>();
    expectTypeOf(a()).toEqualTypeOf<HTMLAnchorElement>();
    expectTypeOf(tagFactory("section")()).toEqualTypeOf<HTMLElement>();
    expectTypeOf(tagFactory("ul")()).toEqualTypeOf<HTMLUListElement>();
    // A tag name TypeScript does not know is still an HTMLElement at runtime.
    const custom = tagFactory("my-widget")();
    expectTypeOf(custom).toEqualTypeOf<HTMLElement>();
    expect(custom).toBeInstanceOf(HTMLElement);
  });

  it("regression: SVG factories return SVGElementTagNameMap types", () => {
    const root = svg();
    const dot = circle({ r: "4" });
    expectTypeOf(root).toEqualTypeOf<SVGSVGElement>();
    expectTypeOf(dot).toEqualTypeOf<SVGCircleElement>();
    expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(dot.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("regression: onElement receives the element's specific type (HTML and SVG)", () => {
    let seenInput: HTMLInputElement | null = null;
    let seenSvg: SVGSVGElement | null = null;
    const el = input({
      onElement: (node) => {
        expectTypeOf(node).toEqualTypeOf<HTMLInputElement>();
        seenInput = node;
      },
    });
    const root = svg({
      onElement: (node) => {
        expectTypeOf(node).toEqualTypeOf<SVGSVGElement>();
        seenSvg = node;
      },
    });
    expect(seenInput).toBe(el);
    expect(seenSvg).toBe(root);
  });
});

describe("regression: one public Component type accepted everywhere", () => {
  it("regression: a component returning div() fits mount / onMount / onUnmount without casts", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const mounted: string[] = [];
    const App: Component = () => {
      const root = div("app");
      onMount(() => {
        mounted.push("mount");
        return undefined;
      }, root);
      onUnmount(() => mounted.push("unmount"), root);
      return root;
    };

    const handle = mount(App, container);
    await flush();
    expect(container.textContent).toBe("app");
    expect(mounted).toEqual(["mount"]);
    handle.unmount();
    expect(mounted).toEqual(["mount", "unmount"]);
  });

  it("regression: Component carries props and a precise root type", () => {
    const Badge: Component<{ label: string }, HTMLSpanElement> = (props) => span(props.label);
    const el = Badge({ label: "new" });
    expectTypeOf(el).toEqualTypeOf<HTMLSpanElement>();
    expect(el.textContent).toBe("new");
  });

  it("regression: lazy and Suspense accept the factory's return type", async () => {
    const Page: Component = () => div("page");
    const LazyPage = lazy(() => Promise.resolve({ default: Page }));
    const el = Suspense({ nodes: () => LazyPage(), fallback: () => span("loading") });
    document.body.appendChild(el);
    expectTypeOf(el).toEqualTypeOf<HTMLDivElement>();
    expect(el.textContent).toBe("loading");
    await flush();
    await flush();
    expect(el.textContent).toBe("page");
    dispose(el);
  });

  it("regression: lazy keeps the loaded component's root type", () => {
    const Div = () => div();
    const LazyDiv = lazy(() => Promise.resolve({ default: Div }));
    // Either the loading container (a div) or the loaded root (a div).
    expectTypeOf(LazyDiv).returns.toEqualTypeOf<HTMLDivElement>();
  });

  it("regression: Portal accepts a component returning div()", async () => {
    const target = document.createElement("section");
    document.body.appendChild(target);
    const anchor = Portal(() => div("overlay"), target);
    document.body.appendChild(anchor);
    await flush();
    expect(target.textContent).toBe("overlay");
    dispose(anchor);
    expect(target.textContent).toBe("");
  });

  it("regression: defineComponent / withProps / withWrapper / withDefaults accept div() roots", () => {
    const Button = defineComponent<{ label: string; variant?: string }>({
      defaults: { variant: "primary" },
      setup: (props) => div({ class: `btn btn-${props.variant}` }, props.label),
    });
    const Small = withProps(Button, (outer: { text: string }) => ({ label: outer.text }));
    const Logged = withWrapper(Button, (Comp, props) => div([Comp(props)]));
    const Defaulted = withDefaults(Button, { variant: "ghost" });

    expectTypeOf(Button({ label: "x" })).toEqualTypeOf<HTMLElement>();
    expect(Button({ label: "Go" }).className).toBe("btn btn-primary");
    expect(Small({ text: "Hi" }).textContent).toBe("Hi");
    expect(Logged({ label: "L" }).firstElementChild?.textContent).toBe("L");
    expect(Defaulted({ label: "D" }).className).toBe("btn btn-ghost");
  });

  it("regression: SVG roots are accepted wherever an Element is enough", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const Icon: Component = () => svg([circle({ r: "4" })]);
    const handle = mount(Icon, container);
    const root = handle.node as Element;
    expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");

    let fired = 0;
    const standalone = svg();
    container.appendChild(standalone);
    onMount(() => {
      fired++;
      return undefined;
    }, standalone);
    onUnmount(() => fired++, standalone);

    const target = document.createElement("div");
    document.body.appendChild(target);
    const anchor = Portal(() => svg(), target);

    const suspended = Suspense({ nodes: () => svg(), fallback: () => span("…") });
    const LazyIcon = lazy(() => Promise.resolve({ default: Icon }));
    const lazyEl = LazyIcon();

    const SvgButton = defineComponent<{ size: number }, SVGSVGElement>({
      setup: (props) => svg({ width: String(props.size) }),
    });
    expectTypeOf(SvgButton({ size: 3 })).toEqualTypeOf<SVGSVGElement>();

    await flush();
    await flush();
    expect(fired).toBe(1);
    expect(target.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(suspended.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(lazyEl.namespaceURI === "http://www.w3.org/2000/svg" || lazyEl.querySelector("svg") !== null).toBe(true);

    dispose(standalone);
    expect(fired).toBe(2);
    dispose(anchor);
    dispose(suspended);
    handle.unmount();
  });
});

describe("regression: props accept live values", () => {
  it("regression: id getter binds reactively and never contains function source", () => {
    const [id, setId] = signal("first");
    const el = div({ id: () => id() });
    expect(el.id).toBe("first");
    expect(el.id).not.toContain("=>");
    setId("second");
    expect(el.id).toBe("second");
    dispose(el);
    setId("third");
    expect(el.id).toBe("second");
  });

  it("regression: static id still works", () => {
    expect(div({ id: "plain" }).id).toBe("plain");
  });

  it("regression: ref<HTMLInputElement>() fits the ref prop under strict", () => {
    const inputRef = ref<HTMLInputElement>();
    const el = input({ ref: inputRef, type: "text" });
    expect(inputRef.current).toBe(el);
    // The ref is typed for element-specific access without a cast.
    expectTypeOf(inputRef.current).toEqualTypeOf<HTMLInputElement | undefined>();
    inputRef.current?.select();

    // `ref<T | null>(null)` keeps working too.
    const nullable = ref<HTMLDivElement | null>(null);
    const d = div({ ref: nullable });
    expect(nullable.current).toBe(d);
  });

  it("regression: on handlers may declare the specific event type", () => {
    const keys: string[] = [];
    let clicks = 0;
    const el = input({
      on: {
        keydown: (e: KeyboardEvent) => keys.push(e.key),
        click: (e) => {
          // `MouseEvent`, or its `PointerEvent` subtype in newer DOM libs.
          expectTypeOf(e).toExtend<MouseEvent>();
          clicks++;
        },
        // Custom events stay allowed.
        "my-event": (e: Event) => keys.push(e.type),
        "my-detail": (e: CustomEvent<string>) => keys.push(e.detail),
      },
    });
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    el.dispatchEvent(new MouseEvent("click"));
    el.dispatchEvent(new Event("my-event"));
    el.dispatchEvent(new CustomEvent("my-detail", { detail: "payload" }));
    expect(keys).toEqual(["Enter", "my-event", "payload"]);
    expect(clicks).toBe(1);
  });

  it("regression: class getter may return undefined / null / false and renders no class", () => {
    const [on, setOn] = signal(false);
    const el = div({ class: () => (on() ? "active" : undefined) });
    expect(el.hasAttribute("class")).toBe(false);
    setOn(true);
    expect(el.getAttribute("class")).toBe("active");
    setOn(false);
    expect(el.hasAttribute("class")).toBe(false);

    const falsy = div({ class: () => on() && "on" });
    expect(falsy.hasAttribute("class")).toBe(false);
    const nul = div({ class: () => null });
    expect(nul.hasAttribute("class")).toBe(false);
    dispose(el);
    dispose(falsy);
    dispose(nul);
  });

  it("regression: style getter may return a style object", () => {
    const [wide, setWide] = signal(true);
    const el = div({ style: () => (wide() ? { width: "10px", color: "red" } : { color: "blue" }) });
    expect(el.style.width).toBe("10px");
    expect(el.style.color).toBe("red");
    setWide(false);
    expect(el.style.width).toBe("");
    expect(el.style.color).toBe("blue");
    dispose(el);
  });

  it("regression: input type and anchor target accept getters", () => {
    const [show, setShow] = signal(false);
    const pw = input({ type: () => (show() ? "text" : "password") });
    expect(pw.getAttribute("type")).toBe("password");
    setShow(true);
    expect(pw.getAttribute("type")).toBe("text");

    const [external, setExternal] = signal(false);
    const link = a({ href: "/x", target: () => (external() ? "_blank" : "_self") });
    expect(link.getAttribute("target")).toBe("_self");
    setExternal(true);
    expect(link.getAttribute("target")).toBe("_blank");
    dispose(pw);
    dispose(link);
  });
});

describe("regression: no private Component types (BUGS.md B3)", () => {
  it("regression: an SVG-rooted remote component needs no cast", async () => {
    const Remote = defineRemoteComponent("svg-icon", async () => ({ default: () => svg({ viewBox: "0 0 1 1" }) }));
    expectTypeOf(Remote).toEqualTypeOf<Component<void, SVGSVGElement | HTMLElement>>();
    const first = Remote();
    expect(first.tagName).toBe("DIV");
    await flush();
    // Once loaded, the remote component's own SVG root is returned.
    expect(Remote().tagName.toLowerCase()).toBe("svg");
  });

  it("regression: the default remote component type is unchanged", () => {
    // Existing callers typed the result as `() => HTMLElement`; it still is one.
    const Remote: () => HTMLElement = defineRemoteComponent("html", async () => ({ default: () => div("x") }));
    expectTypeOf(Remote()).toMatchTypeOf<HTMLElement>();
  });

  it("regression: the router's Component is the public Component", () => {
    expectTypeOf<RouterComponent>().toEqualTypeOf<Component<void, Element>>();
    const svgRoute: RouterComponent = () => svg();
    expect(svgRoute().tagName.toLowerCase()).toBe("svg");
  });
});
