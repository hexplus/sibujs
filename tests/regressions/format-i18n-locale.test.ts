import { afterEach, describe, expect, it } from "vitest";
import { formatCurrency, formatNumber } from "../../src/browser/format";
import { span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { runInSSRContext } from "../../src/core/ssr-context";
import { setLocale } from "../../src/plugins/i18n";

describe("formatNumber / formatCurrency follow the i18n locale (BUGS.md B2)", () => {
  afterEach(() => setLocale("en"));

  it("regression: a formatNumber binding re-formats in place when the locale switches", () => {
    setLocale("en");
    const host = document.createElement("div");
    const el = span(() => formatNumber(1234567.5));
    host.appendChild(el);
    expect(el.textContent).toBe("1,234,567.5");
    setLocale("de");
    expect(el.textContent).toBe("1.234.567,5");
    // The SAME element is updated in place; nothing around it is rebuilt.
    expect(host.firstChild).toBe(el);
  });

  it("regression: a formatCurrency binding follows setLocale()", () => {
    setLocale("en-US");
    const [price] = signal(1234.5);
    const el = span(() => formatCurrency(price(), "EUR"));
    expect(el.textContent).toBe("€1,234.50");
    setLocale("de-DE");
    expect(el.textContent).toBe("1.234,50\u00a0€");
  });

  it("an explicit locale option still wins over the i18n locale", () => {
    setLocale("de");
    expect(formatNumber(1234.5, { locale: "en-US" })).toBe("1,234.5");
    expect(formatCurrency(9.99, "USD", { locale: "en-US" })).toBe("$9.99");
  });

  it("uses the request's locale during an SSR render, without touching the client's", async () => {
    setLocale("en");
    const rendered = await runInSSRContext(async () => {
      setLocale("de");
      return formatNumber(1234.5);
    });
    expect(rendered).toBe("1.234,5");
    expect(formatNumber(1234.5)).toBe("1,234.5");
  });
});
