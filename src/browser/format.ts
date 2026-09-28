/**
 * Locale-aware number and currency formatting using Intl.NumberFormat.
 *
 * LOCALE. An explicit `locale` option always wins. Without one, the active i18n
 * locale is used when the i18n plugin is loaded (`setLocale()` / `getLocale()`),
 * and the runtime's default locale otherwise. The i18n read is reactive, so a
 * formatter called inside a binding re-formats in place when the locale
 * switches:
 *
 * ```ts
 * span(() => formatCurrency(price(), "EUR"));   // follows setLocale("es")
 * ```
 *
 * On the server the read is request-scoped, exactly as `getLocale()` is.
 *
 * @example
 * ```ts
 * formatNumber(1234567.89);                         // "1,234,567.89" (locale-dependent)
 * formatNumber(0.85, { style: "percent" });          // "85%"
 * formatCurrency(9.99, "USD");                       // "$9.99"
 * formatCurrency(1234, "EUR", { locale: "de-DE" });  // "1.234,00 €"
 * ```
 */

const I18N_STATE = Symbol.for("sibujs.i18n.v1");

/**
 * The locale the i18n plugin says is active, or `undefined` when the plugin is
 * not loaded — in which case `Intl` falls back to the runtime default, as
 * before.
 *
 * Read through the plugin's shared singleton rather than an import, so the
 * formatters do not pull the i18n plugin into every bundle that formats a
 * number. The singleton is only READ here, never created: creating it would
 * install i18n's own `"en"` default in applications that never use i18n.
 */
function activeI18nLocale(): string | undefined {
  const state = (globalThis as Record<symbol, unknown>)[I18N_STATE] as
    | { getLocale?: () => string; locale?: [() => string, unknown] }
    | undefined;
  if (!state) return undefined;
  // `getLocale` is attached by current copies of the plugin; an older copy
  // only exposes the client signal.
  return state.getLocale ? state.getLocale() : state.locale?.[0]();
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions & { locale?: string }): string {
  const { locale, ...formatOptions } = options ?? {};
  return new Intl.NumberFormat(locale ?? activeI18nLocale(), formatOptions).format(value);
}

/** Options for {@link formatCurrency}: any `Intl.NumberFormat` option except the ones it fixes. */
export type CurrencyFormatOptions = Omit<Intl.NumberFormatOptions, "style" | "currency"> & { locale?: string };

export function formatCurrency(value: number, currency: string, options?: CurrencyFormatOptions): string {
  const { locale, ...formatOptions } = options ?? {};
  // `style` and `currency` are applied LAST: spread after them, options could
  // switch the currency away from the positional argument or format a percent.
  return new Intl.NumberFormat(locale ?? activeI18nLocale(), {
    ...formatOptions,
    style: "currency",
    currency,
  }).format(value);
}
