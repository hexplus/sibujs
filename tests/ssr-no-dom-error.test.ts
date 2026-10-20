// @vitest-environment node
/**
 * Building a tree with no global `document` fails with an actionable error.
 *
 * SibuJS tag factories return live DOM nodes, so `renderToString(App())` on a
 * server needs a DOM implementation (happy-dom, jsdom) registered as globals.
 * Without one, the first builder call used to die with
 * `ReferenceError: document is not defined` from deep inside the factory. Each
 * public tree builder now checks first and says what to do instead.
 */
import { describe, expect, it } from "vitest";

const NEEDS_DOM = /renderToString needs a DOM/;

describe("tree builders without a global document", () => {
  it("confirms there is no DOM in this environment", () => {
    expect(typeof document).toBe("undefined");
  });

  it("div() throws the actionable error, also inside runInSSRContext", async () => {
    const { div } = await import("../src/core/rendering/html");
    const { runInSSRContext } = await import("../src/core/ssr-context");
    expect(() => div("x")).toThrow(NEEDS_DOM);
    expect(() => runInSSRContext(() => div("x"))).toThrow(NEEDS_DOM);
  });

  it("names the setup in the message", async () => {
    const { div } = await import("../src/core/rendering/html");
    let message = "";
    try {
      div("x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/happy-dom/);
    expect(message).toMatch(/jsdom/);
  });

  it("svg(), Fragment, when, match, each and html`` throw it too", async () => {
    const { svg } = await import("../src/core/rendering/html");
    const { Fragment } = await import("../src/core/rendering/fragment");
    const { when, match } = await import("../src/core/rendering/directives");
    const { each } = await import("../src/core/rendering/each");
    const { html } = await import("../src/core/rendering/htm");
    expect(() => svg({ viewBox: "0 0 1 1" })).toThrow(NEEDS_DOM);
    expect(() => Fragment(["x"])).toThrow(NEEDS_DOM);
    expect(() =>
      when(
        () => true,
        () => "x",
      ),
    ).toThrow(NEEDS_DOM);
    expect(() => match(() => "a", { a: () => "x" })).toThrow(NEEDS_DOM);
    expect(() =>
      each(
        () => [1],
        () => "x",
        { key: (n) => n },
      ),
    ).toThrow(NEEDS_DOM);
    expect(() => html`<p>x</p>`).toThrow(NEEDS_DOM);
  });

  it("KeepAlive and Portal throw it too", async () => {
    const { KeepAlive } = await import("../src/core/rendering/keepAlive");
    const { Portal } = await import("../src/core/rendering/portal");
    expect(() => KeepAlive(() => "a", { a: () => ({}) as never })).toThrow(NEEDS_DOM);
    expect(() => Portal(() => ({}) as never)).toThrow(NEEDS_DOM);
  });
});
