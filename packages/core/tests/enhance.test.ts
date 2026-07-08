import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { enhance, enhanceAll } from "../src/platform/enhance";

function serverRender(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("enhance() — attach to existing DOM (the moat)", () => {
  it("drives existing text reactively WITHOUT replacing the node", () => {
    const root = serverRender(`<div data-counter><b data-ref="n">0</b></div>`);
    const staticNode = root.querySelector('[data-ref="n"]') as HTMLElement;

    const [n, setN] = signal(0);
    enhance(root, (ctx) => ctx.text("@n", () => n()));

    // Server text was "0"; binding reflects current signal value.
    expect(staticNode.textContent).toBe("0");
    setN(5);
    expect(staticNode.textContent).toBe("5");

    // The decisive assertion: the *same* node object is still in the DOM —
    // enhance attached to it, it did not re-render a replacement.
    expect(root.querySelector('[data-ref="n"]')).toBe(staticNode);
  });

  it("wires events to refs and reflects state back", () => {
    const root = serverRender(`<div><span data-ref="out">0</span><button data-ref="inc">+</button></div>`);
    const [n, setN] = signal(0);
    enhance(root, (ctx) => {
      ctx.text("@out", () => n());
      ctx.on("@inc", "click", () => setN((v) => v + 1));
    });

    (root.querySelector('[data-ref="inc"]') as HTMLButtonElement).click();
    (root.querySelector('[data-ref="inc"]') as HTMLButtonElement).click();
    expect(root.querySelector('[data-ref="out"]')?.textContent).toBe("2");
  });

  it("binds attributes, classes, and visibility", () => {
    const root = serverRender(`<div><a data-ref="link">x</a></div>`);
    const [open, setOpen] = signal(true);
    const link = root.querySelector('[data-ref="link"]') as HTMLElement;

    enhance(root, (ctx) => {
      ctx.attr("@link", "aria-expanded", () => open());
      ctx.classed("@link", "is-open", () => open());
      ctx.show("@link", () => open());
    });

    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(link.classList.contains("is-open")).toBe(true);
    expect(link.hidden).toBe(false);

    setOpen(false);
    expect(link.getAttribute("aria-expanded")).toBe("false"); // literal — a11y-correct
    expect(link.classList.contains("is-open")).toBe(false);
    expect(link.hidden).toBe(true);
  });

  it("show() reveals an element the server rendered with the `hidden` attribute", () => {
    // The exact case the islands example hit: a `<p hidden>` revealed on action.
    const root = serverRender(`<div><p data-ref="msg" hidden>thanks</p></div>`);
    const msg = root.querySelector('[data-ref="msg"]') as HTMLElement;
    const [sent, setSent] = signal(false);

    enhance(root, (ctx) => ctx.show("@msg", () => sent()));
    expect(msg.hidden).toBe(true); // server-hidden, stays hidden

    setSent(true);
    expect(msg.hidden).toBe(false); // revealed (style.display alone couldn't do this)
  });

  it("two-way binds a control with model()", () => {
    const root = serverRender(`<form><input data-ref="name" value="seed" /></form>`);
    const input = root.querySelector('[data-ref="name"]') as HTMLInputElement;
    const [name, setName] = signal("seed");

    enhance(root, (ctx) => ctx.model("@name", [name, setName]));

    // signal → control
    setName("alice");
    expect(input.value).toBe("alice");

    // control → signal
    input.value = "bob";
    input.dispatchEvent(new Event("input"));
    expect(name()).toBe("bob");
  });

  it("dispose() stops effects and removes listeners; disposing the DOM also cleans up", () => {
    const root = serverRender(`<div><b data-ref="n">0</b><button data-ref="b">x</button></div>`);
    let clicks = 0;
    const [n, setN] = signal(0);
    const node = root.querySelector('[data-ref="n"]') as HTMLElement;

    const teardown = enhance(root, (ctx) => {
      ctx.text("@n", () => n());
      ctx.on("@b", "click", () => clicks++);
    });

    setN(1);
    expect(node.textContent).toBe("1");

    teardown();
    setN(2);
    expect(node.textContent).toBe("1"); // effect stopped
    (root.querySelector('[data-ref="b"]') as HTMLButtonElement).click();
    expect(clicks).toBe(0); // listener removed

    // And disposal is also tied to the element (no double-run thanks to the guard).
    expect(() => dispose(root)).not.toThrow();
  });

  it("enhanceAll() enhances every match and disposes all", () => {
    document.body.innerHTML = `
      <div class="c"><b data-ref="n">0</b></div>
      <div class="c"><b data-ref="n">0</b></div>`;
    const [n, setN] = signal(0);
    const teardown = enhanceAll(".c", (ctx) => ctx.text("@n", () => n()));

    setN(7);
    const nodes = Array.from(document.querySelectorAll('.c [data-ref="n"]'));
    expect(nodes.map((x) => x.textContent)).toEqual(["7", "7"]);

    teardown();
    setN(9);
    expect(nodes.map((x) => x.textContent)).toEqual(["7", "7"]); // all stopped
  });

  it("warns and no-ops on a selector that matches nothing", () => {
    const teardown = enhance("#nope", () => {});
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
  });
});

describe("enhance() — production hardening", () => {
  it("does not touch the node when the binding matches the server value (no re-paint)", () => {
    const root = serverRender(`<div><b data-ref="n">5</b></div>`);
    const node = root.querySelector('[data-ref="n"]') as HTMLElement;
    // Spy on the text node so we can prove it's never rewritten when seeded.
    const textNode = node.firstChild as Text;
    const [n] = signal(5); // seeded to match the server markup

    enhance(root, (ctx) => ctx.text("@n", () => n()));
    expect(node.textContent).toBe("5");
    expect(node.firstChild).toBe(textNode); // same text node — not replaced/rewritten
  });

  it("updates to the signal value when it differs from the server (intentional change)", () => {
    // Progressive enhancement: changing server content on activation is a normal
    // pattern, not a hydration error — it just works, silently.
    const root = serverRender(`<div><b data-ref="status">Loading…</b></div>`);
    const node = root.querySelector('[data-ref="status"]') as HTMLElement;
    const [status] = signal("Ready");

    enhance(root, (ctx) => ctx.text("@status", () => status()));
    expect(node.textContent).toBe("Ready");
  });

  it("refuses to enhance the same element twice (no double-wiring)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = serverRender(`<div><b data-ref="n">0</b></div>`);
    const [n, setN] = signal(0);

    enhance(root, (ctx) => ctx.text("@n", () => n()));
    const second = enhance(root, (ctx) => ctx.text("@n", () => n())); // already enhanced
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already enhanced"), root);
    expect(typeof second).toBe("function");

    setN(3);
    expect(root.querySelector('[data-ref="n"]')?.textContent).toBe("3"); // single binding, correct
  });
});
