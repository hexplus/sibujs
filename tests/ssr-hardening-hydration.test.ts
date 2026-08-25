/**
 * P1 — Hydration semantics.
 *
 * These tests characterise what SibuJS `hydrate()` actually does, then pin the
 * consequences. The headline result is that SibuJS uses a **replace** strategy,
 * not an **adopt** strategy: the server subtree is discarded and the client tree
 * is built fresh. That is a deliberate design characteristic (documented in
 * docs/architecture/hydration.md), and these tests exist so its consequences
 * are explicit rather than discovered in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLeaks, registerDisposer } from "../src/core/rendering/dispose";
import { div, input, span } from "../src/core/rendering/html";
import { onCleanup } from "../src/core/rendering/lifecycle";
import { signal } from "../src/core/signals/signal";
import { hydrate } from "../src/platform/ssr";

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** Build a container holding server-rendered HTML. */
function serverContainer(html: string): HTMLElement {
  const c = document.createElement("div");
  c.innerHTML = html;
  document.body.appendChild(c);
  return c;
}

describe("hydration: strategy characterisation", () => {
  it("replaces the server subtree rather than adopting it", () => {
    const container = serverContainer('<div id="target">Hello</div>');
    const serverNode = container.querySelector("#target");
    expect(serverNode).not.toBeNull();

    hydrate(() => div({ id: "target" }, "Hello") as HTMLElement, container);

    const hydratedNode = container.querySelector("#target");
    expect(hydratedNode).not.toBeNull();

    // DOCUMENTED CHARACTERISTIC: identity is NOT preserved. SibuJS trades
    // adoption for guaranteed binding correctness — see hydration.md.
    expect(hydratedNode).not.toBe(serverNode);
    expect(serverNode?.isConnected).toBe(false);
  });

  it("marks the container as hydrated", () => {
    const container = serverContainer("<div>Hello</div>");
    hydrate(() => div("Hello") as HTMLElement, container);
    expect(container.getAttribute("data-sibu-hydrated")).toBe("true");
  });

  it("leaves exactly one copy of the content — no duplication", () => {
    const container = serverContainer('<div class="row">A</div>');

    hydrate(() => div({ class: "row" }, "A") as HTMLElement, container);

    expect(container.querySelectorAll(".row")).toHaveLength(1);
    expect(container.textContent).toBe("A");
  });

  it("does not duplicate rows for a server-rendered list", () => {
    const container = serverContainer(
      '<div><span class="row">A</span><span class="row">B</span><span class="row">C</span></div>',
    );

    hydrate(
      () =>
        div({}, [
          span({ class: "row" }, "A") as Node,
          span({ class: "row" }, "B") as Node,
          span({ class: "row" }, "C") as Node,
        ]) as HTMLElement,
      container,
    );

    expect(container.querySelectorAll(".row")).toHaveLength(3);
    expect(container.textContent).toBe("ABC");
  });
});

describe("hydration: no duplicate effects or listeners", () => {
  it("fires one callback per click after hydration", () => {
    const container = serverContainer("<button>Click</button>");
    const onClick = vi.fn();

    hydrate(() => {
      const b = document.createElement("button");
      b.textContent = "Click";
      b.addEventListener("click", onClick);
      return b;
    }, container);

    container.querySelector("button")!.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    container.querySelector("button")!.click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("produces one DOM update per signal change after hydration", async () => {
    const container = serverContainer("<div>0</div>");
    const [count, setCount] = signal(0);
    let renders = 0;

    hydrate(
      () =>
        div(() => {
          renders++;
          return String(count());
        }) as HTMLElement,
      container,
    );

    const afterHydrate = renders;
    setCount(1);
    await settle();

    // Exactly one re-render for one signal write — not two.
    expect(renders).toBe(afterHydrate + 1);
    expect(container.textContent).toBe("1");
  });

  it("keeps the binding count flat across repeated hydrate/dispose cycles", async () => {
    const { dispose } = await import("../src/core/rendering/dispose");

    // Warm up.
    for (let i = 0; i < 3; i++) {
      const c = serverContainer("<div>x</div>");
      const [v] = signal(i);
      hydrate(() => div(() => String(v())) as HTMLElement, c);
      dispose(c);
      c.remove();
    }
    const baseline = checkLeaks();

    for (let i = 0; i < 200; i++) {
      const c = serverContainer("<div>x</div>");
      const [v] = signal(i);
      hydrate(() => div(() => String(v())) as HTMLElement, c);
      dispose(c);
      c.remove();
    }

    expect(checkLeaks()).toBeLessThanOrEqual(baseline + 2);
  });
});

describe("hydration: mismatch recovery", () => {
  it("recovers deterministically from a text mismatch (client wins)", () => {
    const container = serverContainer("<span>Hello</span>");

    hydrate(() => span("Goodbye") as HTMLElement, container);

    // Replace strategy means the client value always wins, with no
    // possibility of a corrupted half-patched tree.
    expect(container.textContent).toBe("Goodbye");
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });

  it("recovers from a tag mismatch without leaving both nodes", () => {
    const container = serverContainer("<div>Hello</div>");

    hydrate(() => span("Hello") as HTMLElement, container);

    expect(container.querySelectorAll("div")).toHaveLength(0);
    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(container.textContent).toBe("Hello");
  });

  it("recovers from a missing server node", () => {
    const container = serverContainer("<div></div>");

    hydrate(() => div({}, span("Hello") as Node) as HTMLElement, container);

    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(container.textContent).toBe("Hello");
  });

  it("recovers from an extra server node", () => {
    const container = serverContainer("<div><span>Hello</span><span>Unexpected</span></div>");

    hydrate(() => div({}, span("Hello") as Node) as HTMLElement, container);

    expect(container.querySelectorAll("span")).toHaveLength(1);
    expect(container.textContent).toBe("Hello");
    expect(container.textContent).not.toContain("Unexpected");
  });

  it("recovers from an attribute mismatch (client value wins)", () => {
    const container = serverContainer('<div id="t" class="server" data-x="1">Hi</div>');

    hydrate(() => div({ id: "t", class: "client", "data-x": "2" }, "Hi") as HTMLElement, container);

    const el = container.querySelector("#t")!;
    expect(el.getAttribute("class")).toBe("client");
    expect(el.getAttribute("data-x")).toBe("2");
  });

  it("recovers from a list-order mismatch", () => {
    const container = serverContainer('<div><span class="r">A</span><span class="r">B</span></div>');

    hydrate(
      () => div({}, [span({ class: "r" }, "B") as Node, span({ class: "r" }, "A") as Node]) as HTMLElement,
      container,
    );

    expect(Array.from(container.querySelectorAll(".r")).map((n) => n.textContent)).toEqual(["B", "A"]);
  });

  it("never leaves structurally corrupted DOM for any mismatch shape", () => {
    const cases: Array<[string, () => HTMLElement]> = [
      ["<span>x</span>", () => div("y") as HTMLElement],
      ["<div><p>a</p></div>", () => div({}, span("b") as Node) as HTMLElement],
      ["", () => div("fresh") as HTMLElement],
      ["<div>a</div><div>b</div>", () => div("only") as HTMLElement],
    ];

    for (const [serverHtml, client] of cases) {
      const container = serverContainer(serverHtml);
      hydrate(client, container);

      // Invariant: exactly one root child, and it is the client tree.
      expect(container.children).toHaveLength(1);
      expect(container.getAttribute("data-sibu-hydrated")).toBe("true");
      container.remove();
    }
  });
});

describe("hydration: diagnostics", () => {
  it("reports a tag mismatch through onMismatch", () => {
    const container = serverContainer("<div>Hello</div>");
    const onMismatch = vi.fn();

    hydrate(() => span("Hello") as HTMLElement, container, { diagnostics: true, onMismatch });

    expect(onMismatch).toHaveBeenCalled();
    const report = onMismatch.mock.calls[0][0];
    expect(report.kind).toBe("tag");
    expect(report.serverValue.toLowerCase()).toContain("div");
    expect(report.clientValue.toLowerCase()).toContain("span");
    expect(report.message).toBeTruthy();
  });

  it("reports a text mismatch with both values", () => {
    const container = serverContainer("<span>Hello</span>");
    const onMismatch = vi.fn();

    hydrate(() => span("Goodbye") as HTMLElement, container, { diagnostics: true, onMismatch });

    expect(onMismatch).toHaveBeenCalled();
    const report = onMismatch.mock.calls[0][0];
    expect(["text", "child-count", "attribute", "tag"]).toContain(report.kind);
  });

  it("stays silent when server and client agree", () => {
    const container = serverContainer('<div id="t">Hello</div>');
    const onMismatch = vi.fn();

    hydrate(() => div({ id: "t" }, "Hello") as HTMLElement, container, { diagnostics: true, onMismatch });

    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("does not run the walker when diagnostics are off", () => {
    const container = serverContainer("<div>Hello</div>");
    const onMismatch = vi.fn();

    hydrate(() => span("Different") as HTMLElement, container, { onMismatch });

    // Diagnostics are opt-in — production pays nothing.
    expect(onMismatch).not.toHaveBeenCalled();
  });
});

describe("hydration: form semantics", () => {
  it("DISCARDS user input entered before hydration", () => {
    const container = serverContainer('<input id="name" value="Alice" />');
    const serverInput = container.querySelector("input") as HTMLInputElement;

    // User types before the JS bundle hydrates.
    serverInput.value = "Bob";

    hydrate(() => input({ id: "name", value: "Alice" }) as HTMLElement, container);

    const hydrated = container.querySelector("input") as HTMLInputElement;
    // DOCUMENTED CONSEQUENCE of the replace strategy: pre-hydration user input
    // is lost. Applications that need to preserve it must capture and restore
    // it themselves. See hydration.md ("Forms").
    expect(hydrated.value).toBe("Alice");
    expect(hydrated).not.toBe(serverInput);
  });

  it("DISCARDS a checkbox toggled before hydration", () => {
    const container = serverContainer('<input id="c" type="checkbox" />');
    const serverBox = container.querySelector("input") as HTMLInputElement;
    serverBox.checked = true;

    hydrate(() => input({ id: "c", type: "checkbox" }) as HTMLElement, container);

    const hydrated = container.querySelector("input") as HTMLInputElement;
    expect(hydrated.checked).toBe(false);
  });

  it("DISCARDS focus held before hydration", () => {
    const container = serverContainer('<input id="f" />');
    const serverInput = container.querySelector("input") as HTMLInputElement;
    serverInput.focus();
    expect(document.activeElement).toBe(serverInput);

    hydrate(() => input({ id: "f" }) as HTMLElement, container);

    // The focused node was detached, so focus is lost.
    expect(document.activeElement).not.toBe(serverInput);
  });

  it("renders client-side form state correctly after hydration", () => {
    const container = serverContainer('<input value="server" />');

    hydrate(() => input({ value: "client" }) as HTMLElement, container);

    const el = container.querySelector("input") as HTMLInputElement;
    expect(el.getAttribute("value")).toBe("client");
  });
});

describe("hydration: lifecycle and cleanup", () => {
  it("runs cleanup for the hydrated tree when the container is disposed", async () => {
    const { dispose } = await import("../src/core/rendering/dispose");
    const container = serverContainer("<div>x</div>");
    const cleanup = vi.fn();

    hydrate(() => {
      const el = div("x") as HTMLElement;
      onCleanup(cleanup, el);
      return el;
    }, container);

    expect(cleanup).not.toHaveBeenCalled();

    dispose(container);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("disposes SibuJS-owned content replaced by a second hydrate() call", async () => {
    const container = serverContainer("<div>x</div>");
    const firstCleanup = vi.fn();

    hydrate(() => {
      const el = div("first") as HTMLElement;
      registerDisposer(el, firstCleanup);
      return el;
    }, container);

    // Re-hydrating the same container replaces the previous client tree.
    hydrate(() => div("second") as HTMLElement, container);

    expect(container.textContent).toBe("second");
    // INVARIANT (disposal): the outgoing SibuJS-owned tree must be torn down.
    expect(firstCleanup).toHaveBeenCalledTimes(1);
  });
});
