/**
 * Navigation-target safety policy.
 *
 * Invariant under test: the router applies **one** target policy across every
 * programmatic entrypoint. The same target must not be accepted by `navigate()`
 * and refused by a route `redirect` (or vice versa).
 *
 * Policy:
 *   internal (path / `?query` / `#hash` / relative)  → SPA navigation
 *   external (absolute http(s)/mailto/tel/ftp, `//host`) → refused, `unsafe-target`
 *   unsafe   (javascript:, data:, vbscript:, blob:, file:, …) → refused, `unsafe-target`
 *
 * Validation always happens **before** any history mutation. A browser
 * `SecurityError` from `pushState` is never the enforcement mechanism.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beforeResolve,
  createRouter,
  destroyRouter,
  navigate,
  RouterLink,
  beforeEach as routerBeforeEach,
  setRoutes,
} from "../src/plugins/router";

const stub = (label: string) => () => {
  const d = document.createElement("div");
  d.textContent = label;
  return d;
};

/** Targets that must never reach SPA navigation. */
const EXTERNAL_TARGETS = [
  "https://example.com",
  "https://example.com/path",
  "http://example.com",
  "//example.com",
  "//example.com/path",
];

const DANGEROUS_TARGETS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
];

/** Targets that must keep working as ordinary SPA navigation. */
const INTERNAL_TARGETS = ["/internal", "/search?q=https%3A%2F%2Fexample.com", "/path/javascript%3Afoo"];

describe("router navigation-target policy", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/internal", component: stub("internal") },
      { path: "/search", component: stub("search") },
      { path: "/path/:rest", component: stub("path") },
      { path: "/safe", component: stub("safe") },
    ]);
    pushSpy = vi.spyOn(window.history, "pushState");
    replaceSpy = vi.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  const historyUntouched = () => pushSpy.mock.calls.length === 0 && replaceSpy.mock.calls.length === 0;

  describe("navigate() (NAV-001)", () => {
    for (const target of EXTERNAL_TARGETS) {
      it(`refuses the external target ${JSON.stringify(target)} before mutating history`, async () => {
        const result = await navigate(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
        expect(historyUntouched()).toBe(true);
        expect(window.location.pathname).toBe("/");
      });
    }

    for (const target of DANGEROUS_TARGETS) {
      it(`refuses the dangerous target ${JSON.stringify(target)}`, async () => {
        const result = await navigate(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
        expect(historyUntouched()).toBe(true);
      });
    }

    for (const target of INTERNAL_TARGETS) {
      it(`still navigates to the internal target ${JSON.stringify(target)}`, async () => {
        const result = await navigate(target);
        expect(result.success).toBe(true);
      });
    }

    it("supports hash-only navigation", async () => {
      await navigate("/internal");
      const result = await navigate("#section");
      expect(result.success).toBe(true);
    });

    it("supports query-only navigation", async () => {
      await navigate("/internal");
      const result = await navigate("?q=test");
      expect(result.success).toBe(true);
    });
  });

  describe("route redirect (NAV-002)", () => {
    const redirectTo = async (redirect: string) => {
      setRoutes([
        { path: "/", component: stub("home") },
        { path: "/from", redirect },
        { path: "/internal", component: stub("internal") },
      ]);
      return navigate("/from");
    };

    for (const target of [...EXTERNAL_TARGETS, ...DANGEROUS_TARGETS]) {
      it(`refuses redirecting to ${JSON.stringify(target)}`, async () => {
        const result = await redirectTo(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
      });
    }

    it("still follows an internal redirect", async () => {
      const result = await redirectTo("/internal");
      expect(result.success).toBe(true);
    });
  });

  describe("beforeEach redirect (NAV-002)", () => {
    const guardRedirectTo = async (redirect: string) => {
      setRoutes([
        { path: "/", component: stub("home") },
        { path: "/guarded", component: stub("guarded") },
        { path: "/internal", component: stub("internal") },
      ]);
      routerBeforeEach((to, _from, next) => next(to.path === "/guarded" ? redirect : true));
      return navigate("/guarded");
    };

    for (const target of [...EXTERNAL_TARGETS, ...DANGEROUS_TARGETS]) {
      it(`refuses redirecting to ${JSON.stringify(target)}`, async () => {
        const result = await guardRedirectTo(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
      });
    }

    it("still follows an internal guard redirect", async () => {
      const result = await guardRedirectTo("/internal");
      expect(result.success).toBe(true);
    });
  });

  describe("beforeResolve redirect (NAV-002)", () => {
    const resolveRedirectTo = async (redirect: string) => {
      setRoutes([
        { path: "/", component: stub("home") },
        { path: "/guarded", component: stub("guarded") },
        { path: "/internal", component: stub("internal") },
      ]);
      beforeResolve((to, _from, next) => next(to.path === "/guarded" ? redirect : true));
      return navigate("/guarded");
    };

    for (const target of [...EXTERNAL_TARGETS, ...DANGEROUS_TARGETS]) {
      it(`refuses redirecting to ${JSON.stringify(target)}`, async () => {
        const result = await resolveRedirectTo(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
      });
    }

    it("still follows an internal beforeResolve redirect", async () => {
      const result = await resolveRedirectTo("/internal");
      expect(result.success).toBe(true);
    });
  });

  // RouterLink deliberately has a *different* policy from navigate(): an
  // external absolute URL is a legitimate `<a href>` and must keep native
  // browser navigation rather than being fed into SPA routing.
  describe("RouterLink click policy (NAV-001)", () => {
    let host: HTMLElement;

    beforeEach(() => {
      host = document.createElement("div");
      document.body.appendChild(host);
    });

    afterEach(() => host.remove());

    /** Click a link and report whether the router intercepted it. */
    const clickOf = (to: string) => {
      const link = RouterLink({ to }, "go");
      host.appendChild(link);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(ev);
      return { link, prevented: ev.defaultPrevented };
    };

    for (const target of ["https://example.com", "http://example.com/path"]) {
      it(`leaves native navigation intact for the external target ${JSON.stringify(target)}`, async () => {
        const { link, prevented } = clickOf(target);
        // The href is real — this is a working external link…
        expect(link.getAttribute("href")).toBe(target);
        // …and the router does not intercept it.
        expect(prevented).toBe(false);
        expect(historyUntouched()).toBe(true);
      });
    }

    for (const target of ["//example.com", ...DANGEROUS_TARGETS]) {
      it(`neutralizes the unsafe target ${JSON.stringify(target)}`, async () => {
        const { link, prevented } = clickOf(target);
        // No executable href is ever exposed.
        expect(link.getAttribute("href")).toBe("#");
        // The click is swallowed rather than routed or followed.
        expect(prevented).toBe(true);
        expect(historyUntouched()).toBe(true);
      });
    }

    for (const target of ["/internal", "/search?q=a", "/internal#section"]) {
      it(`still SPA-intercepts the internal target ${JSON.stringify(target)}`, async () => {
        const { link, prevented } = clickOf(target);
        expect(link.getAttribute("href")).toBe(target);
        expect(prevented).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
        expect(pushSpy.mock.calls.length + replaceSpy.mock.calls.length).toBeGreaterThan(0);
      });
    }

    it("does not intercept a modifier click on an internal target", () => {
      const link = RouterLink({ to: "/internal" }, "go");
      host.appendChild(link);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
      link.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });

    it("does not intercept when target=_blank", () => {
      const link = RouterLink({ to: "/internal", target: "_blank" }, "go");
      host.appendChild(link);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  describe("beforeEnter redirect (NAV-002)", () => {
    const enterRedirectTo = async (redirect: string) => {
      setRoutes([
        { path: "/", component: stub("home") },
        { path: "/guarded", component: stub("guarded"), beforeEnter: () => redirect },
        { path: "/internal", component: stub("internal") },
      ]);
      return navigate("/guarded");
    };

    for (const target of [...EXTERNAL_TARGETS, ...DANGEROUS_TARGETS]) {
      it(`refuses redirecting to ${JSON.stringify(target)}`, async () => {
        const result = await enterRedirectTo(target);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.reason).toBe("unsafe-target");
      });
    }
  });
});
