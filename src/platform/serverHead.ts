// ============================================================================
// SERVER-SIDE HEAD COLLECTION
// ============================================================================
//
// In a browser `Head()` and the router's route `head` write into
// `document.head`. During a server render there is no document head to write
// into, so both record their entries in the request instead, and the async
// renderers emit them as `result.head`.
//
// A layer is OWNED: recording it returns a withdraw function, which `Head()`
// ties to its anchor's disposal and the router calls when it is destroyed. A
// layer may be a resolver, evaluated when the head is collected rather than
// when it is recorded, so a getter reading data that arrived while the render
// settled contributes its settled value.

import { requestSlot } from "../core/ssr-context";
import { untracked } from "../reactivity/track";

/** A head layer recorded during a server render; later layers win per key. */
export interface ServerHeadLayer {
  /** The title, already resolved (template applied). */
  title?: string | null;
  /** Ordered tags; `key` dedupes across layers (`name:description`, `property:og:title`, `link:canonical`). */
  tags: Array<{ key: string; html: string }>;
}

/** A layer, or a resolver producing it when the head is collected (`null`: nothing to contribute). */
export type ServerHeadSource = ServerHeadLayer | (() => ServerHeadLayer | null);

interface LayerEntry {
  source: ServerHeadSource | null;
}

interface HeadSlot {
  layers: LayerEntry[];
}

function headSlot(): HeadSlot | undefined {
  return requestSlot<HeadSlot>("head", () => ({ layers: [] }));
}

/**
 * Record a head layer for the current server render. Outside a request scope
 * it does nothing and returns `null`, so a caller falls back to `document.head`.
 *
 * @param source The title and tags this source contributes, or a resolver
 * evaluated when the head is collected.
 * @returns A function withdrawing the layer (idempotent), or `null` outside a
 * request scope.
 */
export function recordServerHead(source: ServerHeadSource): (() => void) | null {
  const slot = headSlot();
  if (!slot) return null;
  const entry: LayerEntry = { source };
  slot.layers.push(entry);
  return () => {
    if (entry.source === null) return;
    // Released, not only skipped: a withdrawn layer keeps no component closure.
    entry.source = null;
    const index = slot.layers.indexOf(entry);
    if (index !== -1) slot.layers.splice(index, 1);
  };
}

/**
 * The head markup for the current request: the last title any live layer set,
 * and every tag deduplicated by key — the layer recorded LAST wins its key, and
 * keeps the position of the first layer that set it. Resolvers run here, so
 * call it once the render has settled and BEFORE the tree is disposed.
 *
 * @returns Escaped head markup, or `""`.
 * @throws When a head value getter throws; the error is the cause.
 */
export function collectServerHead(): string {
  const slot = headSlot();
  if (!slot || slot.layers.length === 0) return "";
  let title: string | null | undefined;
  const order: string[] = [];
  const byKey = new Map<string, string>();
  // A snapshot: a resolver must not be able to reorder what is being walked.
  for (const entry of slot.layers.slice()) {
    const source = entry.source;
    if (source === null) continue;
    let layer: ServerHeadLayer | null;
    try {
      layer = typeof source === "function" ? untracked(source) : source;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[SibuJS SSR] a head value threw while the page head was collected: ${message}`, {
        cause: err,
      });
    }
    if (!layer) continue;
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
