/**
 * Locale-aware number and currency formatting using Intl.NumberFormat.
 *
 * @example
 * ```ts
 * formatNumber(1234567.89);                         // "1,234,567.89" (locale-dependent)
 * formatNumber(0.85, { style: "percent" });          // "85%"
 * formatCurrency(9.99, "USD");                       // "$9.99"
 * formatCurrency(1234, "EUR", { locale: "de-DE" });  // "1.234,00 €"
 * ```
 */

export function formatNumber(value: number, options?: Intl.NumberFormatOptions & { locale?: string }): string {
  const { locale, ...formatOptions } = options ?? {};
  return new Intl.NumberFormat(locale, formatOptions).format(value);
}

/** Options for {@link formatCurrency}: any `Intl.NumberFormat` option except the ones it fixes. */
export type CurrencyFormatOptions = Omit<Intl.NumberFormatOptions, "style" | "currency"> & { locale?: string };

export function formatCurrency(value: number, currency: string, options?: CurrencyFormatOptions): string {
  const { locale, ...formatOptions } = options ?? {};
  // `style` and `currency` are applied LAST: spread after them, options could
  // switch the currency away from the positional argument or format a percent.
  return new Intl.NumberFormat(locale, {
    ...formatOptions,
    style: "currency",
    currency,
  }).format(value);
}
