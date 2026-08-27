import { effect } from "../core/signals/effect";
import { acquireTitle, type ResourceLease } from "../utils/documentResources";

/**
 * title sets `document.title` reactively. Accepts a static string
 * or a reactive getter function. Returns a dispose function that
 * hands the title back to its previous owner.
 *
 * Ownership is a STACK shared with `Head({ title })` — see
 * `utils/documentResources`. A per-instance "previous title" snapshot, which is
 * what this used to keep, restores a stale value whenever three owners overlap
 * and the middle one is disposed first: it writes back the title that was
 * current when IT mounted, overwriting the owner that is actually visible.
 *
 * @param value Static string or reactive getter for the document title
 * @returns Dispose function that releases this owner's claim
 */
export function title(value: string | (() => string)): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  if (typeof value === "function") {
    let lease: ResourceLease<string> | null = null;
    const cleanup = effect(() => {
      const next = value();
      // The lease is acquired on the FIRST run so it is created with a real
      // value — acquiring with a placeholder would flash it into the document.
      if (lease) lease.set(next);
      else lease = acquireTitle(next);
    });

    return () => {
      cleanup();
      lease?.release();
      lease = null;
    };
  }

  // Static string
  const lease = acquireTitle(value);
  return () => lease.release();
}
