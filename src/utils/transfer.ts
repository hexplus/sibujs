/**
 * Server → browser data transfer.
 *
 * A server render (`renderToStringAsync`, `renderRoute`, the pre-renderer)
 * collects the data its `query()` cache, keyed `resource()`s and loaders
 * produced, and embeds it in the document as ONE escaped script:
 *
 *   <script>window.__SIBU_TRANSFER__={"v":1,"q":{...},"r":{...}}</script>
 *
 * The browser primes its caches from that payload before the app builds, so
 * data that is still fresh is not fetched a second time.
 *
 * Subsystems register a *collector* (server side) under a short section name,
 * and read their section back with {@link takeTransferred} (client side). The
 * registry lives on `globalThis` so duplicate module copies share it.
 */

import { getRequestStore } from "../core/ssr-context";
import { isUnsafeKey, readOwnGlobal } from "./guards";

/** The window global the transfer script assigns. */
export const TRANSFER_GLOBAL = "__SIBU_TRANSFER__";

/** Payload layout version. A payload with another version is ignored. */
export const TRANSFER_VERSION = 1;

/** A section collector: returns the section's entries for the current request. */
export type TransferCollector = () => Record<string, unknown> | undefined;

interface TransferRegistry {
  collectors: Map<string, TransferCollector>;
  /** Client: the parsed payload, `null` once read and found absent/invalid. */
  payload: Record<string, Record<string, unknown>> | null | undefined;
}

const REGISTRY_KEY = Symbol.for("sibujs.transfer.v1");

function registry(): TransferRegistry {
  const g = globalThis as Record<symbol, TransferRegistry | undefined>;
  let r = g[REGISTRY_KEY];
  if (!r) {
    r = { collectors: new Map(), payload: undefined };
    g[REGISTRY_KEY] = r;
  }
  return r;
}

/**
 * Register the server-side collector for one payload section. Idempotent per
 * name, so a duplicate module copy re-registering is harmless.
 *
 * @param section Short section name (`q` for queries, `r` for resources).
 * @param collect Returns the section's entries for the CURRENT request.
 */
export function registerTransferCollector(section: string, collect: TransferCollector): void {
  registry().collectors.set(section, collect);
}

/**
 * Collect every section for the current request. Server only.
 *
 * @returns The payload, or `null` when no section has entries.
 */
export function collectTransfer(): Record<string, unknown> | null {
  if (!getRequestStore()) return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [section, collect] of registry().collectors) {
    const entries = collect();
    if (!entries) continue;
    // `__proto__` and friends would turn into a prototype assignment in the
    // emitted object literal; they never cross.
    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(entries)) if (!isUnsafeKey(key)) safe[key] = entries[key];
    if (Object.keys(safe).length > 0) {
      out[section] = safe;
      any = true;
    }
  }
  if (!any) return null;
  out.v = TRANSFER_VERSION;
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readPayload(): Record<string, Record<string, unknown>> | null {
  const r = registry();
  if (r.payload !== undefined) return r.payload;
  r.payload = null;
  if (typeof window === "undefined" || getRequestStore()) return null;
  // Own property only: an element with that id would otherwise answer.
  const raw = readOwnGlobal(TRANSFER_GLOBAL);
  if (!isPlainRecord(raw) || raw.v !== TRANSFER_VERSION) return null;
  const sections: Record<string, Record<string, unknown>> = Object.create(null);
  for (const key of Object.keys(raw)) {
    const section = raw[key];
    if (key === "v" || isUnsafeKey(key) || !isPlainRecord(section)) continue;
    const entries: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(section)) if (!isUnsafeKey(k)) entries[k] = section[k];
    sections[key] = entries;
  }
  r.payload = sections;
  return sections;
}

/**
 * Read (once) the entries a server render transferred for `section`. Client
 * only; returns `undefined` on the server and when the page carries no payload.
 * Each entry is handed out once, so a later cache reset does not resurrect
 * build-time data.
 *
 * @param section The section name used by the collector.
 * @param key The entry key.
 * @returns The transferred value, or `undefined`.
 */
export function takeTransferred(section: string, key: string): unknown {
  const entries = readPayload()?.[section];
  if (!entries || !Object.hasOwn(entries, key)) return undefined;
  const value = entries[key];
  delete entries[key];
  return value;
}

/**
 * Every remaining entry of `section`, consumed. Client only.
 *
 * @param section The section name used by the collector.
 * @returns The entries (possibly empty).
 */
export function takeTransferredSection(section: string): Record<string, unknown> {
  const payload = readPayload();
  const entries = payload?.[section];
  if (!payload || !entries) return {};
  delete payload[section];
  return entries;
}

/** Test helper: forget the parsed payload so the next read parses the global again. @internal */
export function __resetTransfer(): void {
  registry().payload = undefined;
}
