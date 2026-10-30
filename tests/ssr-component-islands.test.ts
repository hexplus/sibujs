import { afterEach, describe, expect, it, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { button, div, h1, li, p, section, span, ul } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { islandComponent } from "../src/platform/componentIsland";
import { lazyIsland, mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";
import { island } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";

interface CartProps {
  items: string[];
  note: string;
}

function Cart(props: CartProps): HTMLElement {
  const [count, setCount] = signal(props.items.length);
  return div({ class: "cart" }, [
    ul([
      each(
        () => props.items,
        (item) => li(item()),
        { key: (x) => x },
      ),
    ]),
    p(() => `items: ${count()}`),
    span({ class: "note" }, props.note),
    button({ on: { click: () => setCount((n) => n + 1) } }, "add"),
  ]);
}

function Page(): HTMLElement {
  return div({ class: "page" }, [
    h1("Marketing"),
    section({ class: "static" }, [p("Static copy that ships no JavaScript.")]),
    island("cart", Cart, { items: ["mug", "cap"], note: '</script><b>"quoted"</b>' }, { load: "load" }),
  ]);
}

let root: HTMLElement;

afterEach(() => {
  root?.remove();
  unregisterIsland("cart");
  unregisterIsland("lazy-cart");
  vi.restoreAllMocks();
});

async function serverPage(page: () => HTMLElement = Page): Promise<HTMLElement> {
  const { html } = await renderToStringAsync(page);
  root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("component islands from a server render", () => {
  it("marks the island and its props on the server; the page itself carries no adoption ids", async () => {
    const { html } = await renderToStringAsync(Page);
    expect(html).toContain('data-sibu-island="cart"');
    expect(html).toContain('data-sibu-load="load"');
    expect(html).toContain("data-sibu-props=");
    // Props are an escaped attribute value: no markup escapes it.
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("&lt;/script&gt;&lt;b&gt;");
    const before = html.slice(0, html.indexOf('data-sibu-island="cart"'));
    expect(before).not.toContain("data-sibu-h");
    expect(html.slice(html.indexOf('data-sibu-island="cart"'))).toContain('data-sibu-h="');
  });

  it("adopts only the island: its nodes become live, the rest of the page stays inert", async () => {
    await serverPage();
    const staticSection = root.querySelector(".static") as HTMLElement;
    const cartRoot = root.querySelector(".cart");
    const lis = Array.from(root.querySelectorAll(".cart li"));
    const outside: MutationRecord[] = [];
    const mo = new MutationObserver((r) =>
      outside.push(...r.filter((m) => !(root.querySelector("[data-sibu-island]") as Node).contains(m.target))),
    );
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const addListener = vi.spyOn(EventTarget.prototype, "addEventListener");

    registerIsland("cart", islandComponent<CartProps>(Cart));
    const cleanup = mountIslands(root);
    await tick();
    await tick();
    mo.disconnect();

    expect(root.querySelector(".cart")).toBe(cartRoot);
    expect(Array.from(root.querySelectorAll(".cart li"))).toEqual(lis);
    expect(root.querySelector(".note")?.textContent).toBe('</script><b>"quoted"</b>');
    (root.querySelector(".cart button") as HTMLButtonElement).click();
    expect(root.querySelector(".cart p")?.textContent).toBe("items: 3");

    // Nothing outside the island was touched, and no listener landed there.
    expect(outside).toEqual([]);
    for (const call of addListener.mock.calls) {
      const target = addListener.mock.contexts[addListener.mock.calls.indexOf(call)] as Node;
      if (target instanceof Node && root.contains(target)) {
        expect((root.querySelector("[data-sibu-island]") as Node).contains(target)).toBe(true);
      }
    }
    expect(staticSection.isConnected).toBe(true);
    cleanup();
  });

  it("waits for its load strategy: an interaction island adopts on first interaction", async () => {
    const InteractivePage = () => div([island("cart", Cart, { items: ["a"], note: "n" }, { load: "interaction" })]);
    await serverPage(InteractivePage);
    const setup = vi.fn(islandComponent<CartProps>(Cart));
    registerIsland("cart", setup);
    mountIslands(root);
    await tick();
    expect(setup).not.toHaveBeenCalled();
    root.querySelector(".cart")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await tick();
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("loads a lazy island's chunk only when it activates", async () => {
    const LazyPage = () => div([island("lazy-cart", Cart, { items: ["x"], note: "n" }, { load: "interaction" })]);
    await serverPage(LazyPage);
    const loader = vi.fn(async () => ({ default: islandComponent<CartProps>(Cart) }));
    registerIsland("lazy-cart", lazyIsland(loader));
    mountIslands(root);
    await tick();
    expect(loader).not.toHaveBeenCalled();
    root.querySelector(".cart")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const lazyLi = root.querySelector(".cart li");
    await tick();
    await tick();
    expect(loader).toHaveBeenCalledTimes(1);
    // Adopted, not replaced: the server's node is the live one.
    expect(root.querySelector(".cart li")).toBe(lazyLi);
    expect(root.querySelector("[data-sibu-island]")?.getAttribute("data-sibu-enhanced")).toBe("true");
  });

  it("refuses props that fail the island's validator", async () => {
    await serverPage();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const isCart = (v: unknown): v is CartProps =>
      typeof v === "object" && v !== null && Array.isArray((v as CartProps).items) && (v as CartProps).items.length > 5;
    registerIsland("cart", islandComponent<CartProps>(Cart, isCart));
    mountIslands(root);
    await tick();
    expect(error).toHaveBeenCalled();
    expect(root.querySelector("[data-sibu-island]")?.hasAttribute("data-sibu-hydrated")).toBe(false);
  });

  it("renders the component normally outside a server render", async () => {
    const el = island("cart", Cart, { items: ["a"], note: "n" });
    await tick();
    expect(el.querySelector(".cart li")?.textContent).toBe("a");
    expect(el.querySelector("[data-sibu-h]")).toBeNull();
  });
});
