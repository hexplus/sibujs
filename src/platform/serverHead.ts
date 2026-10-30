// ============================================================================
// SERVER-SIDE HEAD COLLECTION
// ============================================================================
//
// In a browser `Head()` and the router's route `head` write into
// `document.head`. During a server render there is no document head to write
// into, so both record their entries in the request instead, and the async
// renderers emit them as `result.head`.

import { requestSlot } from "../core/ssr-context";

/** A head layer recorded during a server render; later layers win per key. */
export interface ServerHeadLayer {
  /** The title, already resolved (template applied). */
  title?: string | null;
  /** Ordered tags; `key` dedupes across layers (`name:description`, `property:og:title`, `link:canonical`). */
  tags: Array<{ key: string; html: string }>;
}

interface HeadSlot {
  layers: ServerHeadLayer[];
}

function headSlot(): HeadSlot | undefined {
  return requestSlot<HeadSlot>("head", () => ({ layers: [] }));
}

/**
 * Record a head layer for the current server render. Outside a request scope
 * it does nothing and returns `false`, so a caller falls back to `document.head`.
 *
 * @param layer The title and tags this source contributes.
 * @returns `true` when the layer was recorded for a server render.
 */
export function recordServerHead(layer: ServerHeadLayer): boolean {
  const slot = headSlot();
  if (!slot) return false;
  slot.layers.push(layer);
  return true;
}

/**
 * The head markup for the current request: the last title any layer set, and
 * every tag deduplicated by key — the layer recorded LAST wins its key, and
 * keeps the position of the first layer that set it.
 *
 * @returns Escaped head markup, or `""`.
 */
export function collectServerHead(): string {
  const slot = headSlot();
  if (!slot || slot.layers.length === 0) return "";
  let title: string | null | undefined;
  const order: string[] = [];
  const byKey = new Map<string, string>();
  for (const layer of slot.layers) {
    if (layer.title !== undefined) title = layer.title;
    for (const tag of layer.tags) {
      if (!byKey.has(tag.key)) order.push(tag.key);
      byKey.set(tag.key, tag.html);
    }
  }
  const out: string[] = [];
  if (title != null) out.push(`<title>${escapeText(title)}</title>`);
  for (const key of order) out.push(byKey.get(key) as string);
  return out.join("\n    ");
}

function escapeText(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
