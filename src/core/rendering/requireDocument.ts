import { DEV } from "../dev";

/**
 * Throw the actionable "no DOM" error.
 *
 * SibuJS builders return live DOM nodes, so building a tree — on the server
 * too, before `renderToString` serializes it — needs a global `document`. In a
 * bare Node process the first builder call used to fail with
 * `ReferenceError: document is not defined` from deep inside the framework,
 * which reads like a bug rather than a missing setup step. The public tree
 * builders (tag factories, `html`, `Fragment`, `when`, `match`, `each`) check
 * first and throw this instead.
 *
 * The production message is short; development adds the setup line.
 */
export function noDocument(): never {
  throw new Error(
    "[SibuJS] renderToString needs a DOM: register happy-dom or jsdom globals first." +
      (DEV
        ? " There is no global `document`, and SibuJS builds live DOM nodes, on the server too. For example: " +
          'import { GlobalRegistrator } from "@happy-dom/global-registrator"; GlobalRegistrator.register(); ' +
          "See SSR in AGENTS.md §10."
        : ""),
  );
}

/** {@link noDocument} unless a global `document` exists. */
export function requireDocument(): void {
  if (typeof document === "undefined") noDocument();
}
