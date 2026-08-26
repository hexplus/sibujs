/**
 * `RouterLink` active-state matching contract.
 *
 * Invariants under test:
 *  - Ancestor matching respects path *segment* boundaries. `/user` is an
 *    ancestor of `/user/123` but not of `/users`.
 *  - `/` is active only on `/` — it is not treated as an ancestor of every route.
 *  - Trailing slashes are normalized on both sides.
 *  - `exactActive` is full normalized target identity: pathname + query + hash.
 *    `/search?q=a` and `/search?q=b` are distinct navigation targets.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, destroyRouter, navigate, Route, RouterLink, setRoutes } from "../src/plugins/router";

const ACTIVE = "router-link-active";
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

describe("RouterLink: active-state matching", () => {
  let host: HTMLElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/user", component: stub("user") },
      { path: "/user/:id", component: stub("user-detail") },
      { path: "/users", component: stub("users") },
      { path: "/users/:id", component: stub("users-detail") },
      { path: "/product", component: stub("product") },
      { path: "/products", component: stub("products") },
      { path: "/search", component: stub("search") },
      { path: "/docs", component: stub("docs") },
    ]);
    host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());
  });

  afterEach(() => {
    destroyRouter();
    host.remove();
  });

  /** Mount a link, navigate, and report its resolved active state. */
  async function stateOf(to: string, current: string) {
    const link = RouterLink({ to });
    host.appendChild(link);
    await navigate(current);
    await settle();
    return {
      active: link.className.includes(ACTIVE),
      exact: link.className.includes(EXACT),
    };
  }

  describe("segment-boundary ancestor matching (LINK-001)", () => {
    it("does not mark /user active on /users", async () => {
      expect(await stateOf("/user", "/users")).toEqual({ active: false, exact: false });
    });

    it("does not mark /product active on /products", async () => {
      expect(await stateOf("/product", "/products")).toEqual({ active: false, exact: false });
    });

    it("marks /users active on the descendant /users/123", async () => {
      expect(await stateOf("/users", "/users/123")).toEqual({ active: true, exact: false });
    });

    it("marks /user active and exact on /user", async () => {
      expect(await stateOf("/user", "/user")).toEqual({ active: true, exact: true });
    });

    it("marks /user active but not exact on /user/123", async () => {
      expect(await stateOf("/user", "/user/123")).toEqual({ active: true, exact: false });
    });
  });

  describe("root semantics (LINK-002 / root contract)", () => {
    it("marks / active and exact on /", async () => {
      expect(await stateOf("/", "/")).toEqual({ active: true, exact: true });
    });

    it("does not mark / active on /users", async () => {
      expect(await stateOf("/", "/users")).toEqual({ active: false, exact: false });
    });
  });

  describe("trailing-slash normalization", () => {
    it("treats target /users/ as /users when current is /users", async () => {
      expect(await stateOf("/users/", "/users")).toEqual({ active: true, exact: true });
    });

    it("treats current /users/ as /users when target is /users", async () => {
      expect(await stateOf("/users", "/users/")).toEqual({ active: true, exact: true });
    });
  });

  describe("query exact semantics (LINK-002)", () => {
    it("is exact-active when the query matches", async () => {
      expect(await stateOf("/search?q=a", "/search?q=a")).toEqual({ active: true, exact: true });
    });

    it("is active but NOT exact-active when the query differs", async () => {
      expect(await stateOf("/search?q=a", "/search?q=b")).toEqual({ active: true, exact: false });
    });

    it("ignores query parameter order", async () => {
      expect(await stateOf("/search?b=2&a=1", "/search?a=1&b=2")).toEqual({ active: true, exact: true });
    });

    it("is active but NOT exact-active when the target carries a query the route does not", async () => {
      expect(await stateOf("/search?q=a", "/search")).toEqual({ active: true, exact: false });
    });
  });

  describe("hash exact semantics (LINK-002)", () => {
    it("is exact-active when the hash matches", async () => {
      expect(await stateOf("/docs#one", "/docs#one")).toEqual({ active: true, exact: true });
    });

    it("is active but NOT exact-active when the hash differs", async () => {
      expect(await stateOf("/docs#one", "/docs#two")).toEqual({ active: true, exact: false });
    });
  });

  // LINK-003 — active classes are router state. A link the router will never
  // navigate is not router state, whatever its sanitized href happens to parse
  // to.
  describe("non-internal links are never router-active", () => {
    it("does not mark an unsafe link active on the root route", async () => {
      // `javascript:` collapses to href="#", whose pathname parses as "/" —
      // which would otherwise make it exact-active on every root route.
      expect(await stateOf("javascript:alert(1)", "/")).toEqual({ active: false, exact: false });
    });

    for (const target of ["data:text/html,x", "vbscript:msgbox(1)", "//example.com"]) {
      it(`does not mark the unsafe link ${JSON.stringify(target)} active on the root route`, async () => {
        expect(await stateOf(target, "/")).toEqual({ active: false, exact: false });
      });
    }

    it("does not mark an external link active on a matching path", async () => {
      const link = RouterLink({ to: "https://example.com/users" });
      host.appendChild(link);
      await navigate("/users");
      await settle();
      expect(link.className).not.toContain(ACTIVE);
      expect(link.className).not.toContain(EXACT);
    });

    it("does not apply a custom activeClass to a non-internal link", async () => {
      const link = RouterLink({ to: "javascript:alert(1)", activeClass: "on", exactActiveClass: "exact" });
      host.appendChild(link);
      await navigate("/");
      await settle();
      expect(link.className).not.toContain("on");
      expect(link.className).not.toContain("exact");
    });

    it("still marks an ordinary internal link active", async () => {
      expect(await stateOf("/users", "/users")).toEqual({ active: true, exact: true });
    });
  });

  describe("custom class props still honour the same matching", () => {
    it("applies a custom activeClass on a descendant but not the exactActiveClass", async () => {
      const link = RouterLink({ to: "/users", activeClass: "on", exactActiveClass: "exact" });
      host.appendChild(link);
      await navigate("/users/7");
      await settle();
      expect(link.className).toContain("on");
      expect(link.className).not.toContain("exact");
    });

    it("does not apply a custom activeClass across a segment boundary", async () => {
      const link = RouterLink({ to: "/user", activeClass: "on" });
      host.appendChild(link);
      await navigate("/users");
      await settle();
      expect(link.className).not.toContain("on");
    });
  });
});
