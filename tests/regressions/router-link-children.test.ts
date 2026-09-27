import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { createRouter, destroyRouter, RouterLink } from "../../src/plugins/router";

describe("RouterLink accepts the same children as a tag factory", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter([{ path: "/", component: () => document.createElement("div") }], { mode: "history" });
  });
  afterEach(() => destroyRouter());

  it("regression: a getter child renders and stays live", () => {
    const [count, setCount] = signal(1);
    const link = RouterLink({ to: "/cart" }, () => `Cart (${count()})`);
    expect(link.textContent).toBe("Cart (1)");

    setCount(2);
    expect(link.textContent).toBe("Cart (2)");
  });

  it("regression: getters inside a children array render", () => {
    const [label, setLabel] = signal("Home");
    const icon = span({ class: "icon" });
    const link = RouterLink({ to: "/" }, [icon, () => label()]);
    expect(link.firstChild).toBe(icon);
    expect(link.textContent).toBe("Home");

    setLabel("Inicio");
    expect(link.textContent).toBe("Inicio");
  });

  it("regression: a number child renders", () => {
    const link = RouterLink({ to: "/page/3" }, 3);
    expect(link.textContent).toBe("3");
  });
});
