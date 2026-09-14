import { isSSR } from "../core/ssr-context";
import { reactiveBinding } from "./track";

/**
 * Create a reactive DOM update owned by `ownerNode`.
 *
 * Use this instead of `effect()` wherever a reactive update writes to DOM that
 * has a concrete owner (a widget's root, a list container, a form control).
 * A plain effect carries no node, so an exception on a LATER scheduled run is
 * reported with `node: undefined` and the enclosing `ErrorBoundary` can never
 * claim it. `reactiveBinding` stamps the owner, which is what lets
 * `reportError()` walk up to the nearest boundary.
 *
 * SSR parity with `effect()` is deliberate: DOM side effects do not run on the
 * server, so a binding created during SSR is inert and its disposer is a no-op.
 */
export function domBinding(commit: () => void, ownerNode: Node | undefined): () => void {
  if (isSSR()) return () => {};
  return reactiveBinding(commit, ownerNode);
}
