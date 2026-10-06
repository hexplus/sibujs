/**
 * Router query identity: one contract for every comparison.
 *
 * Invariants under test:
 *  - Query identity is order-independent: `?b=2&a=1` is `?a=1&b=2`.
 *  - It is collision-free: a structural character that arrived *encoded*
 *    (`%26`, `%3D`, `%25`) never reads as a delimiter, so `?a=x%26b%3Dy` is
 *    not `?a=x&b=y`.
 *  - It follows `RouteContext.queryAll`'s decoding (`URLSearchParams`) and
 *    counts every value of a repeated key, in order, so a URL is always the
 *    same target as the route it produces — `?tag=a&tag=b` is exact-active
 *    against itself and is not `?tag=b`.
 *  - Duplicate-navigation detection and `RouterLink` exact-active agree on
 *    every case. Each case is checked through BOTH paths.
 *  - `KeepAliveRoute` serves a reordered query from the same cached view.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Route,
  RouterLink,
  route,
  setRoutes,
} from "../src/plugins/router";

const EXACT = "router-link-exact-active";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const stub = (label: string) => () => {
  const d = document.createElement("div");
  d.textContent = label;
  return d;
};

/**
 * `[a, b, same]`: two URLs on the same path, and whether they are the same
 * navigation target.
 */
const CASES: [string, string, boolean, string][] = [
  ["/search?b=2&a=1", "/search?a=1&b=2", true, "reordered parameters"],
  ["/search?a=x%26b%3Dy", "/search?a=x&b=y", false, "encoded & and = inside a value"],
  ["/search?a%3Db=c", "/search?a=b%3Dc", false, "encoded = moves the key/value boundary"],
  ["/search?a=b%3Dc", "/search?a=b=c", true, "a bare = after the first is value text"],
  ["/search?a=%2541", "/search?a=%41", false, "encoded % is a literal percent"],
  ["/search?a=%2541", "/search?a=%2541", true, "encoded % against itself"],
  ["/search?q=a+b", "/search?q=a%20b", true, "+ and %20 both decode to a space"],
  ["/search?q=a%2Bb", "/search?q=a+b", false, "%2B is a literal +"],
  ["/search?a=", "/search?a", true, "empty value with and without ="],
  ["/search?a=", "/search", false, "an empty value is still a parameter"],
  ["/search?=x", "/search?=x", true, "empty key against itself"],
  ["/search?=x", "/search", false, "an empty key is still a parameter"],
  ["/search?tag=a&tag=b", "/search?tag=a&tag=b", true, "repeated key against itself"],
  ["/search?tag=a&tag=b", "/search?tag=b", false, "repeated key: every value counts, not only the last"],
  ["/search?tag=a&tag=b", "/search?tag=a", false, "repeated key: the first value alone is not it"],
  ["/search?tag=a&tag=b", "/search?tag=b&tag=a", false, "repeated key: value order counts"],
  ["/search?tag=a&x=1&tag=b", "/search?x=1&tag=a&tag=b", true, "repeated key: order across keys does not"],
  ["/search?q=%C3%A9", "/search?q=é", true, "encoded and literal Unicode"],
  ["/search?q=%F0%9F%98%80", "/search?q=%F0%9F%98%81", false, "distinct astral characters"],
  ["/search?a=%23b", "/search?a=#b", false, "encoded # is query data, a bare # starts the hash"],
  ["/search?a=1#h", "/search?a=1#h", true, "same query and hash"],
  ["/search?a=1#h", "/search?a=1#g", false, "hash is part of exact identity"],
];

describe("router: canonical query identity", () => {
  let host: HTMLElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/search", component: stub("search") },
      { path: "/other", component: stub("other") },
    ]);
    host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());
  });

  afterEach(() => {
    destroyRouter();
    host.remove();
  });

  async function exactActive(to: string, current: string): Promise<boolean> {
    const link = RouterLink({ to });
    host.appendChild(link);
    await navigate(current);
    await settle();
    const exact = link.className.includes(EXACT);
    link.remove();
    return exact;
  }

  async function isDuplicate(first: string, second: string): Promise<boolean> {
    await navigate("/other");
    const r1 = await navigate(first);
    expect(r1.success).toBe(true);
    const r2 = await navigate(second);
    return !r2.success && r2.reason === "duplicate";
  }

  describe("RouterLink exact-active and duplicate navigation agree", () => {
    for (const [a, b, same, label] of CASES) {
      it(`${label}: ${a} vs ${b} → ${same ? "same" : "different"}`, async () => {
        expect(await exactActive(a, b)).toBe(same);
        expect(await isDuplicate(a, b)).toBe(same);
        // Identity is symmetric.
        expect(await exactActive(b, a)).toBe(same);
        expect(await isDuplicate(b, a)).toBe(same);
      });
    }
  });

  it("a URL with a repeated key produces last-value-wins route params", async () => {
    await navigate("/search?tag=a&tag=b");
    expect(route().query).toEqual({ tag: "b" });
  });

  it("a navigation object with reordered query is a duplicate of the current URL", async () => {
    await navigate("/search?a=1&b=2");
    const r = await navigate({ path: "/search", query: { b: "2", a: "1" } });
    expect(r).toMatchObject({ success: false, reason: "duplicate" });
  });

  it("a navigation object whose value holds & and = is not the split query", async () => {
    await navigate("/search?a=x&b=y");
    const r = await navigate({ path: "/search", query: { a: "x&b=y" } });
    expect(r.success).toBe(true);
    expect(route().query).toEqual({ a: "x&b=y" });
  });
});

describe("KeepAliveRoute: query identity", () => {
  let host: HTMLElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    destroyRouter();
    host.remove();
  });

  it("serves a reordered query from the same cached view, and a colliding one from a new view", async () => {
    const created: HTMLElement[] = [];
    const disposed: HTMLElement[] = [];
    const Search = () => {
      const el = document.createElement("div");
      el.textContent = `search-${created.length + 1}`;
      created.push(el);
      registerDisposer(el, () => disposed.push(el));
      return el;
    };
    createRouter(
      [
        { path: "/", component: stub("home") },
        { path: "/search", name: "search", component: Search },
        { path: "/other", component: stub("other") },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    await navigate("/search?a=1&b=2");
    await settle();
    expect(created).toHaveLength(1);

    await navigate("/other");
    await settle();
    await navigate("/search?b=2&a=1");
    await settle();
    expect(created).toHaveLength(1);
    expect(host.contains(created[0])).toBe(true);

    await navigate("/search?a=1%26b%3D2");
    await settle();
    expect(created).toHaveLength(2);
    expect(disposed).toHaveLength(0);
  });
});
