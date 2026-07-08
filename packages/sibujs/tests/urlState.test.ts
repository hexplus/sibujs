import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { urlState } from "../src/browser/urlState";

describe("urlState", () => {
  let handlers: Record<string, EventListener[]>;
  let location: { pathname: string; search: string; hash: string };
  let historyCalls: Array<{ method: "push" | "replace"; url: string }>;

  beforeEach(() => {
    handlers = {};
    historyCalls = [];
    location = { pathname: "/home", search: "?q=hello", hash: "#top" };

    vi.stubGlobal("window", {
      get location() {
        return location;
      },
      history: {
        pushState: vi.fn((_s: unknown, _t: string, url: string) => {
          historyCalls.push({ method: "push", url });
          applyUrl(url);
        }),
        replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
          historyCalls.push({ method: "replace", url });
          applyUrl(url);
        }),
      },
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        (handlers[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
      }),
    });
  });

  function applyUrl(url: string) {
    const [pathAndQuery, hash] = url.split("#");
    const [pathname, search] = pathAndQuery.split("?");
    location.pathname = pathname;
    location.search = search ? `?${search}` : "";
    location.hash = hash ? `#${hash}` : "";
  }

  function fireEvent(name: string) {
    for (const h of handlers[name] || []) h({} as Event);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- initial state ------------------------------------------------------

  it("reads initial search params and hash", () => {
    const u = urlState();
    expect(u.params().get("q")).toBe("hello");
    expect(u.hash()).toBe("#top");
  });

  // ---- setParams ----------------------------------------------------------

  it("setParams pushes by default and updates signal", () => {
    const u = urlState();
    u.setParams({ q: "world", page: "2" });
    expect(u.params().get("q")).toBe("world");
    expect(u.params().get("page")).toBe("2");
    expect(historyCalls.at(-1)?.method).toBe("push");
  });

  it("setParams with replace uses replaceState", () => {
    const u = urlState();
    u.setParams({ q: "x" }, { replace: true });
    expect(historyCalls.at(-1)?.method).toBe("replace");
  });

  it("setParams accepts URLSearchParams instance", () => {
    const u = urlState();
    const p = new URLSearchParams();
    p.set("foo", "bar");
    u.setParams(p);
    expect(u.params().get("foo")).toBe("bar");
  });

  it("setParams with empty params produces clean URL (no trailing ?)", () => {
    const u = urlState();
    u.setParams(new URLSearchParams());
    expect(historyCalls.at(-1)?.url).toBe("/home#top");
  });

  it("setParams preserves the current hash", () => {
    const u = urlState();
    u.setParams({ q: "new" });
    expect(historyCalls.at(-1)?.url).toContain("#top");
  });

  // ---- setHash ------------------------------------------------------------

  it("setHash normalizes with # prefix", () => {
    const u = urlState();
    u.setHash("section");
    expect(u.hash()).toBe("#section");
  });

  it("setHash keeps # prefix if already present", () => {
    const u = urlState();
    u.setHash("#footer");
    expect(u.hash()).toBe("#footer");
  });

  it("setHash('') clears the hash", () => {
    const u = urlState();
    u.setHash("");
    expect(u.hash()).toBe("");
    expect(historyCalls.at(-1)?.url).toBe("/home?q=hello");
  });

  it("setHash('#') clears the hash (bare # treated as empty)", () => {
    const u = urlState();
    u.setHash("#");
    expect(u.hash()).toBe("");
    expect(historyCalls.at(-1)?.url).toBe("/home?q=hello");
  });

  it("setHash preserves the current params", () => {
    const u = urlState();
    u.setHash("bottom");
    expect(historyCalls.at(-1)?.url).toContain("?q=hello");
  });

  it("setHash with replace uses replaceState", () => {
    const u = urlState();
    u.setHash("x", { replace: true });
    expect(historyCalls.at(-1)?.method).toBe("replace");
  });

  // ---- popstate sync ------------------------------------------------------

  it("syncs from popstate events", () => {
    const u = urlState();
    location.search = "?q=changed";
    location.hash = "#new";
    fireEvent("popstate");
    expect(u.params().get("q")).toBe("changed");
    expect(u.hash()).toBe("#new");
  });

  it("popstate with unchanged URL does not create new URLSearchParams (dedup)", () => {
    const u = urlState();
    const paramsBefore = u.params();
    fireEvent("popstate");
    expect(u.params()).toBe(paramsBefore);
  });

  // ---- hashchange sync (Bug fix regression) -------------------------------

  it("syncs from hashchange events (anchor clicks, location.hash = ...)", () => {
    const u = urlState();
    location.hash = "#anchor";
    fireEvent("hashchange");
    expect(u.hash()).toBe("#anchor");
  });

  it("hashchange with unchanged hash does not notify (dedup)", () => {
    const u = urlState();
    const hashBefore = u.hash();
    fireEvent("hashchange");
    expect(u.hash()).toBe(hashBefore);
  });

  it("hashchange listener is registered on construction", () => {
    urlState();
    expect(handlers["hashchange"]?.length).toBe(1);
  });

  // ---- rapid sequential calls ---------------------------------------------

  it("setParams then setHash produces correct final URL", () => {
    const u = urlState();
    u.setParams({ q: "test" });
    u.setHash("section");
    expect(u.params().get("q")).toBe("test");
    expect(u.hash()).toBe("#section");
    expect(historyCalls.at(-1)?.url).toBe("/home?q=test#section");
  });

  // ---- dispose ------------------------------------------------------------

  it("dispose removes both popstate and hashchange listeners", () => {
    const u = urlState();
    expect(handlers["popstate"]?.length).toBe(1);
    expect(handlers["hashchange"]?.length).toBe(1);
    u.dispose();
    expect(handlers["popstate"]?.length ?? 0).toBe(0);
    expect(handlers["hashchange"]?.length ?? 0).toBe(0);
  });

  // ---- SSR fallback -------------------------------------------------------

  it("returns inert signals when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const u = urlState();
    expect(u.params().toString()).toBe("");
    expect(u.hash()).toBe("");
    u.setParams({ x: "1" });
    u.setHash("y");
    expect(u.params().toString()).toBe("");
    expect(u.hash()).toBe("");
    u.dispose();
  });
});
