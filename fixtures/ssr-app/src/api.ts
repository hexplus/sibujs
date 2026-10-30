// The fixture's API client. Everything goes through `globalThis.fetch`, so a
// test stubs it and a pre-render build points it at a running API.

export interface Product {
  id: string;
  name: string;
  price: number;
  image: string;
  color: string;
}

export interface ServiceStatus {
  ok: boolean;
  checkedAt: string;
}

/** Same-origin API path; a relative URL resolves against the page (or the pre-renderer's origin). */
function apiUrl(path: string): string {
  const base = (globalThis as { __FIXTURE_API__?: string }).__FIXTURE_API__ ?? "";
  return `${base}${path}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), { signal });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchCatalog(signal?: AbortSignal): Promise<Product[]> {
  return getJson<Product[]>("/api/catalog", signal);
}

export function fetchProduct(id: string, signal?: AbortSignal): Promise<Product> {
  return getJson<Product>(`/api/catalog/${encodeURIComponent(id)}`, signal);
}

export function fetchStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  return getJson<ServiceStatus>("/api/status", signal);
}

/** The data the fixture's stub API serves. */
export const CATALOG: Product[] = [
  { id: "taza", name: "Taza personalizada", price: 12, image: "/img/taza.png", color: "#d94f30" },
  { id: "gorra", name: "Gorra bordada", price: 18, image: "/img/gorra.png", color: "#2a6fdb" },
  { id: "camiseta", name: 'Camiseta "DTF" <premium>', price: 22, image: "/img/camiseta.png", color: "#1f9d55" },
];

/**
 * A `fetch` implementation serving the stub API — for tests and for the
 * pre-render build. Counts requests per path so a test can assert that the
 * browser did not fetch transferred data again.
 */
export function createStubFetch(options: { delayMs?: number } = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://fixture.test");
    calls.push(url.pathname);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/catalog") return json(200, CATALOG);
    if (url.pathname.startsWith("/api/catalog/")) {
      const product = CATALOG.find((p) => p.id === decodeURIComponent(url.pathname.slice(13)));
      return product ? json(200, product) : json(404, { error: "not found" });
    }
    if (url.pathname === "/api/status") return json(200, { ok: true, checkedAt: "2026-10-30T12:00:00Z" });
    return json(404, { error: "not found" });
  }) as typeof fetch & { calls: string[] };
  stub.calls = calls;
  return stub;
}
