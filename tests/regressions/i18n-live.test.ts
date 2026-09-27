/**
 * Regression: i18n was not live.
 *
 * WHAT WAS WRONG
 * --------------
 * - `t()` returns a plain string, so it only updated when read inside a
 *   binding, and there was no helper that produced a binding for an ATTRIBUTE
 *   (placeholder, title, aria-label). Applications wrapped the whole shell in
 *   one reactive function instead, and every language switch rebuilt it —
 *   losing element identity, focus and typed input values.
 * - Dictionaries were a plain object: `registerTranslations()` notified
 *   nobody, so `setLocale("es")` followed by a lazy `registerTranslations("es")`
 *   left every binding showing raw keys.
 * - Interpolation parameters were `string | number` only; a getter was
 *   stringified as function source, so a parameter could never be live — in
 *   `t()` or in `Trans()`.
 *
 * Every test below builds its DOM ONCE and then only changes state, asserting
 * that the same nodes are still in place afterwards.
 */

import { afterEach, describe, expect, it } from "vitest";
import { button, footer, form, h1, header, input, label, main, nav, span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { registerTranslations, setLocale, Trans, t, translated } from "../../src/plugins/i18n";

afterEach(() => {
  setLocale("en");
});

describe("regression: i18n switches language live", () => {
  it("regression: an app shell built once switches every text and attribute in place without a rebuild", () => {
    registerTranslations("en", {
      "shell.title": "My Store",
      "shell.nav.home": "Home",
      "shell.nav.cart": "Cart",
      "shell.search.label": "Search",
      "shell.search.placeholder": "Search products…",
      "shell.search.title": "Type to search",
      "shell.search.submit": "Go",
      "shell.footer": "All rights reserved",
    });
    registerTranslations("es", {
      "shell.title": "Mi Tienda",
      "shell.nav.home": "Inicio",
      "shell.nav.cart": "Carrito",
      "shell.search.label": "Buscar",
      "shell.search.placeholder": "Buscar productos…",
      "shell.search.title": "Escribe para buscar",
      "shell.search.submit": "Ir",
      "shell.footer": "Todos los derechos reservados",
    });
    setLocale("en");

    let builds = 0;
    function Shell(): HTMLElement {
      builds++;
      return main([
        header([h1(translated("shell.title"))]),
        nav([span(translated("shell.nav.home")), span(translated("shell.nav.cart"))]),
        form([
          label({ for: "q" }, translated("shell.search.label")),
          input({
            id: "q",
            placeholder: translated("shell.search.placeholder"),
            title: translated("shell.search.title"),
            "aria-label": translated("shell.search.label"),
          }),
          button({ type: "button" }, translated("shell.search.submit")),
        ]),
        footer(translated("shell.footer")),
      ]) as HTMLElement;
    }

    const root = Shell();
    document.body.appendChild(root);

    const elementsBefore = [root, ...Array.from(root.querySelectorAll("*"))];
    const field = root.querySelector("input") as HTMLInputElement;
    field.value = "running shoes";

    expect(root.querySelector("h1")?.textContent).toBe("My Store");
    expect(field.getAttribute("placeholder")).toBe("Search products…");

    setLocale("es");

    // Every string on screen switched…
    expect(root.querySelector("h1")?.textContent).toBe("Mi Tienda");
    expect(Array.from(root.querySelectorAll("nav span")).map((n) => n.textContent)).toEqual(["Inicio", "Carrito"]);
    expect(root.querySelector("label")?.textContent).toBe("Buscar");
    expect(root.querySelector("button")?.textContent).toBe("Ir");
    expect(root.querySelector("footer")?.textContent).toBe("Todos los derechos reservados");
    // …including attributes…
    expect(field.getAttribute("placeholder")).toBe("Buscar productos…");
    expect(field.getAttribute("title")).toBe("Escribe para buscar");
    expect(field.getAttribute("aria-label")).toBe("Buscar");

    // …while the shell itself was never rebuilt: same element nodes, in the
    // same order, and the user's typed value is still in the field.
    const elementsAfter = [root, ...Array.from(root.querySelectorAll("*"))];
    expect(elementsAfter.length).toBe(elementsBefore.length);
    elementsAfter.forEach((node, i) => {
      expect(node).toBe(elementsBefore[i]);
    });
    expect(root.querySelector("input")).toBe(field);
    expect(field.value).toBe("running shoes");
    expect(builds).toBe(1);

    root.remove();
  });

  it("regression: setLocale('es') before registerTranslations('es') shows Spanish once the messages arrive", () => {
    registerTranslations("en", { "late.greeting": "Hello" });
    setLocale("en");

    const el = span(() => t("late.greeting")) as HTMLElement;
    const attrEl = input({ placeholder: () => t("late.greeting") }) as HTMLElement;
    expect(el.textContent).toBe("Hello");

    // The common lazy-loading order: switch first, load the messages after.
    setLocale("xx-late");
    expect(el.textContent).toBe("late.greeting");

    registerTranslations("xx-late", { "late.greeting": "Hola" });
    expect(el.textContent).toBe("Hola");
    expect(attrEl.getAttribute("placeholder")).toBe("Hola");
  });

  it("regression: a getter parameter updates the translated text live", () => {
    registerTranslations("en", { "param.hello": "Hello, {name}!" });
    setLocale("en");

    const [name, setName] = signal("Ada");
    const el = span(() => t("param.hello", { name })) as HTMLElement;
    expect(el.textContent).toBe("Hello, Ada!");

    setName("Grace");
    expect(el.textContent).toBe("Hello, Grace!");
  });

  it("regression: Trans with a getter parameter updates in place", () => {
    registerTranslations("en", { "trans.cart": "{count} items in cart" });
    registerTranslations("es", { "trans.cart": "{count} artículos en el carrito" });
    setLocale("en");

    const [count, setCount] = signal(1);
    const el = Trans("trans.cart", { count });
    expect(el.textContent).toBe("1 items in cart");

    setCount(3);
    expect(el.textContent).toBe("3 items in cart");

    setLocale("es");
    expect(el.textContent).toBe("3 artículos en el carrito");
  });
});
