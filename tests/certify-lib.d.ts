/**
 * Types for the certification helpers that must stay runnable by plain Node.
 *
 * `scripts/certify/lib/declared-exports.mjs` is executed by the certification
 * gate inside a throwaway consumer project, so it cannot be TypeScript. It is
 * still imported by `certify-declared-exports.test.ts`, which is type-checked by
 * `npm run typecheck:tests`, so its shape is declared here rather than left as
 * an untyped import.
 */
declare module "*/declared-exports.mjs" {
  export function declaredExportNames(source: string): Set<string>;
  export function findDeclaredExports(source: string, names: readonly string[]): string[];
}
