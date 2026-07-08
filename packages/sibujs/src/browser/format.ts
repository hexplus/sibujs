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

export function formatCurrency(
  value: number,
  currency: string,
  options?: Intl.NumberFormatOptions & { locale?: string },
): string {
  const { locale, ...formatOptions } = options ?? {};
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...formatOptions,
  }).format(value);
}
