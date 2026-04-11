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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads initial search params and hash", () => {
    const u = urlState();
    expect(u.params().get("q")).toBe("hello");
    expect(u.hash()).toBe("#top");
  });

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

  it("setHash normalizes with # prefix", () => {
    const u = urlState();
    u.setHash("section");
    expect(u.hash()).toBe("#section");
  });

  it("syncs from popstate events", () => {
    const u = urlState();
    location.search = "?q=changed";
    location.hash = "#new";
    for (const h of handlers["popstate"] || []) h({} as Event);
    expect(u.params().get("q")).toBe("changed");
    expect(u.hash()).toBe("#new");
  });

  it("dispose removes popstate listener", () => {
    const u = urlState();
    u.dispose();
    expect(handlers["popstate"]?.length ?? 0).toBe(0);
  });
});
