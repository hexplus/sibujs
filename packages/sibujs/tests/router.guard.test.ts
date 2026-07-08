import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../src/plugins/router";
import {
  createRouter,
  destroyRouter,
  navigate,
  push,
  Route,
  replace,
  route,
  router,
  beforeEach as routerBeforeEach,
  setRoutes,
} from "../src/plugins/router";

// Mock console to reduce noise
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

describe("Router System", () => {
  let cleanup: (() => void)[] = [];
  let routeElement: Node | null = null;

  beforeEach(() => {
    // Clean up any existing router state
    for (const fn of cleanup) fn();
    cleanup = [];

    // Remove any existing route elements
    if (routeElement?.parentNode) {
      routeElement.parentNode.removeChild(routeElement);
      routeElement = null;
    }

    // Reset history
    window.history.replaceState({}, "", "/");

    // Initialize fresh router
    createRouter({
      mode: "history",
      base: "",
      linkActiveClass: "router-link-active",
      linkExactActiveClass: "router-link-exact-active",
    });

    // Clear routes
    setRoutes([]);

    // Suppress console output during tests but allow error capture in specific tests
    if (!vi.isMockFunction(console.error)) {
      console.error = vi.fn();
    }
    if (!vi.isMockFunction(console.log)) {
      console.log = vi.fn();
    }
  });

  afterEach(() => {
    // Restore console
    console.error = originalConsoleError;
    console.log = originalConsoleLog;

    // Clean up router
    for (const fn of cleanup) fn();
    cleanup = [];

    if (routeElement?.parentNode) {
      routeElement.parentNode.removeChild(routeElement);
      routeElement = null;
    }

    // Destroy router to clean up everything
    try {
      destroyRouter();
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  // Helper function to create and mount Route component
  const mountRouter = () => {
    routeElement = Route();
    document.body.appendChild(routeElement);
    return routeElement;
  };

  // Helper function to wait for navigation
  const waitForNavigation = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

  // Helper function to create test components
  const createComponent = (name: string, callback?: () => void) => () => {
    callback?.();
    const div = document.createElement("div");
    div.textContent = name;
    div.setAttribute("data-testid", name);
    return div;
  };

  describe("Basic Routing", () => {
    it("should navigate between simple routes", async () => {
      const log: string[] = [];

      setRoutes([
        { path: "/", component: createComponent("Home", () => log.push("home-rendered")) },
        { path: "/about", component: createComponent("About", () => log.push("about-rendered")) },
      ]);

      mountRouter();

      // Navigate to home
      await navigate("/");
      await waitForNavigation();

      let r = route();
      expect(r.path).toBe("/");
      expect(log).toContain("home-rendered");
      expect(document.querySelector('[data-testid="Home"]')).toBeTruthy();

      // Navigate to about
      await navigate("/about");
      await waitForNavigation();

      r = route();
      expect(r.path).toBe("/about");
      expect(log).toContain("about-rendered");
      expect(document.querySelector('[data-testid="About"]')).toBeTruthy();
    });

    it("should handle route parameters", async () => {
      const capturedParams: Record<string, string>[] = [];

      const UserComponent = () => {
        const r = route();
        capturedParams.push({ ...r.params });
        return createComponent(`User-${r.params.id}`)();
      };

      setRoutes([
        { path: "/user/:id", component: UserComponent },
        { path: "/user/:id/post/:postId", component: UserComponent },
      ]);

      mountRouter();

      // Test single parameter
      await navigate("/user/123");
      await waitForNavigation();

      let r = route();
      expect(r.path).toBe("/user/123");
      expect(r.params.id).toBe("123");
      expect(capturedParams[capturedParams.length - 1]).toEqual({ id: "123" });

      // Test multiple parameters
      await navigate("/user/456/post/789");
      await waitForNavigation();

      r = route();
      expect(r.path).toBe("/user/456/post/789");
      expect(r.params.id).toBe("456");
      expect(r.params.postId).toBe("789");
      expect(capturedParams[capturedParams.length - 1]).toEqual({ id: "456", postId: "789" });
    });

    it("should handle query parameters", async () => {
      const capturedQueries: Record<string, string>[] = [];

      const SearchComponent = () => {
        const r = route();
        capturedQueries.push({ ...r.query });
        return createComponent("Search")();
      };

      setRoutes([{ path: "/search", component: SearchComponent }]);

      mountRouter();

      await navigate("/search?q=test&page=2&sort=date");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/search");
      expect(r.query.q).toBe("test");
      expect(r.query.page).toBe("2");
      expect(r.query.sort).toBe("date");
      expect(capturedQueries[capturedQueries.length - 1]).toEqual({
        q: "test",
        page: "2",
        sort: "date",
      });
    });

    it("should handle hash fragments", async () => {
      setRoutes([{ path: "/docs", component: createComponent("Docs") }]);

      mountRouter();

      await navigate("/docs#section-1");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/docs");
      expect(r.hash).toBe("section-1");
    });
  });

  describe("Route Guards", () => {
    it("should redirect when beforeEnter guard fails", async () => {
      const log: string[] = [];
      const hasAccess = false;

      setRoutes([
        {
          path: "/private",
          component: createComponent("Private", () => log.push("private-rendered")),
          beforeEnter: (_to, _from) => {
            log.push("guard-executed");
            return hasAccess || "/login";
          },
        },
        { path: "/login", component: createComponent("Login", () => log.push("login-rendered")) },
      ]);

      mountRouter();

      // Should redirect to login when access denied
      await navigate("/private");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/login");
      expect(log).toContain("guard-executed");
      expect(log).toContain("login-rendered");
      expect(log).not.toContain("private-rendered");
      expect(document.querySelector('[data-testid="Login"]')).toBeTruthy();
    });

    it("should allow access when beforeEnter guard passes", async () => {
      const log: string[] = [];
      const hasAccess = true;

      setRoutes([
        {
          path: "/private",
          component: createComponent("Private", () => log.push("private-rendered")),
          beforeEnter: (_to, _from) => {
            log.push("guard-executed");
            return hasAccess;
          },
        },
        { path: "/login", component: createComponent("Login", () => log.push("login-rendered")) },
      ]);

      mountRouter();

      await navigate("/private");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/private");
      expect(log).toContain("guard-executed");
      expect(log).toContain("private-rendered");
      expect(log).not.toContain("login-rendered");
      expect(document.querySelector('[data-testid="Private"]')).toBeTruthy();
    });

    it("should handle async guards", async () => {
      const log: string[] = [];

      const asyncAuth = async (): Promise<boolean> => {
        log.push("async-auth-started");
        await new Promise((resolve) => setTimeout(resolve, 10));
        log.push("async-auth-completed");
        return false; // Deny access
      };

      setRoutes([
        {
          path: "/dashboard",
          component: createComponent("Dashboard", () => log.push("dashboard-rendered")),
          beforeEnter: async (_to, _from) => {
            log.push("guard-started");
            const hasAccess = await asyncAuth();
            log.push("guard-completed");
            return hasAccess || "/unauthorized";
          },
        },
        { path: "/unauthorized", component: createComponent("Unauthorized", () => log.push("unauthorized-rendered")) },
      ]);

      mountRouter();

      await navigate("/dashboard");
      await waitForNavigation(200); // Wait longer for async operation

      const r = route();
      expect(r.path).toBe("/unauthorized");
      expect(log).toContain("guard-started");
      expect(log).toContain("async-auth-started");
      expect(log).toContain("async-auth-completed");
      expect(log).toContain("guard-completed");
      expect(log).toContain("unauthorized-rendered");
      expect(log).not.toContain("dashboard-rendered");
    });

    it("should handle multiple guards in array", async () => {
      const log: string[] = [];

      const authGuard = (_to: RouteContext, _from?: RouteContext) => {
        log.push("auth-guard");
        return true; // Pass
      };

      const roleGuard = (_to: RouteContext, _from?: RouteContext) => {
        log.push("role-guard");
        return "/forbidden"; // Redirect
      };

      setRoutes([
        {
          path: "/admin",
          component: createComponent("Admin", () => log.push("admin-rendered")),
          beforeEnter: [authGuard, roleGuard],
        },
        { path: "/forbidden", component: createComponent("Forbidden", () => log.push("forbidden-rendered")) },
      ]);

      mountRouter();

      await navigate("/admin");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/forbidden");
      expect(log).toContain("auth-guard");
      expect(log).toContain("role-guard");
      expect(log).toContain("forbidden-rendered");
      expect(log).not.toContain("admin-rendered");
    });

    it("should handle global beforeEach guards", async () => {
      const log: string[] = [];
      const isAuthenticated = false;

      // Add global guard
      const removeGuard = routerBeforeEach((to, _from, next) => {
        log.push("global-guard");
        if (to.path.startsWith("/protected") && !isAuthenticated) {
          next("/login");
        } else {
          next();
        }
      });
      cleanup.push(removeGuard);

      setRoutes([
        { path: "/protected/area", component: createComponent("Protected", () => log.push("protected-rendered")) },
        { path: "/login", component: createComponent("Login", () => log.push("login-rendered")) },
        { path: "/public", component: createComponent("Public", () => log.push("public-rendered")) },
      ]);

      mountRouter();

      // Should redirect protected route
      await navigate("/protected/area");
      await waitForNavigation(150); // Wait longer for global guards

      let r = route();
      expect(r.path).toBe("/login");
      expect(log).toContain("global-guard");
      expect(log).toContain("login-rendered");
      expect(log).not.toContain("protected-rendered");

      // Should allow public route
      log.length = 0; // Clear log
      await navigate("/public");
      await waitForNavigation();

      r = route();
      expect(r.path).toBe("/public");
      expect(log).toContain("global-guard");
      expect(log).toContain("public-rendered");
    });
  });

  describe("Named Routes", () => {
    it("should navigate to named routes", async () => {
      const log: string[] = [];

      setRoutes([
        {
          path: "/user/:id",
          name: "user",
          component: createComponent("User", () => log.push("user-rendered")),
        },
        {
          path: "/profile/:userId/settings",
          name: "user-settings",
          component: createComponent("Settings", () => log.push("settings-rendered")),
        },
      ]);

      mountRouter();

      // Navigate using route name and params
      await navigate({ name: "user", params: { id: "123" } });
      await waitForNavigation();

      let r = route();
      expect(r.path).toBe("/user/123");
      expect(r.params.id).toBe("123");
      expect(log).toContain("user-rendered");

      // Navigate to complex named route
      await navigate({
        name: "user-settings",
        params: { userId: "456" },
        query: { tab: "notifications" },
      });
      await waitForNavigation();

      r = route();
      expect(r.path).toBe("/profile/456/settings");
      expect(r.params.userId).toBe("456");
      expect(r.query.tab).toBe("notifications");
      expect(log).toContain("settings-rendered");
    });
  });

  describe("Redirect Routes", () => {
    it("should handle static redirects", async () => {
      const log: string[] = [];

      setRoutes([
        { path: "/", redirect: "/home" },
        { path: "/old-path", redirect: "/new-path" },
        { path: "/home", component: createComponent("Home", () => log.push("home-rendered")) },
        { path: "/new-path", component: createComponent("New", () => log.push("new-rendered")) },
      ]);

      mountRouter();

      // Test root redirect
      await navigate("/");
      await waitForNavigation(150); // Wait longer for redirects

      let r = route();
      expect(r.path).toBe("/home");
      expect(log).toContain("home-rendered");

      // Test path redirect
      log.length = 0; // Clear log
      await navigate("/old-path");
      await waitForNavigation(150);

      r = route();
      expect(r.path).toBe("/new-path");
      expect(log).toContain("new-rendered");
    });

    it("should handle dynamic redirects", async () => {
      const log: string[] = [];

      setRoutes([
        {
          path: "/user/:id",
          redirect: (to) => `/profile/${to.params.id}`,
        },
        {
          path: "/profile/:id",
          component: createComponent("Profile", () => log.push("profile-rendered")),
        },
      ]);

      mountRouter();

      await navigate("/user/123");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/profile/123");
      expect(r.params.id).toBe("123");
      expect(log).toContain("profile-rendered");
    });
  });

  describe("Router Utilities", () => {
    it("should provide push/replace/go navigation methods", async () => {
      const log: string[] = [];

      setRoutes([
        { path: "/page1", component: createComponent("Page1", () => log.push("page1")) },
        { path: "/page2", component: createComponent("Page2", () => log.push("page2")) },
        { path: "/page3", component: createComponent("Page3", () => log.push("page3")) },
      ]);

      mountRouter();

      // Test push
      await push("/page1");
      await waitForNavigation();
      expect(route().path).toBe("/page1");

      // Test replace
      await replace("/page2");
      await waitForNavigation();
      expect(route().path).toBe("/page2");

      // Test push again
      await push("/page3");
      await waitForNavigation();
      expect(route().path).toBe("/page3");

      // Note: We can't easily test history.go/back/forward in JSDOM
      // but we can verify the functions exist
      const rt = router();
      expect(typeof rt.go).toBe("function");
      expect(typeof rt.back).toBe("function");
      expect(typeof rt.forward).toBe("function");
    });

    it("should provide router hook with full API", async () => {
      setRoutes([{ path: "/test", component: createComponent("Test") }]);

      mountRouter();
      await navigate("/test");
      await waitForNavigation();

      const rt = router();

      expect(rt.currentRoute.path).toBe("/test");
      expect(typeof rt.push).toBe("function");
      expect(typeof rt.replace).toBe("function");
      expect(typeof rt.go).toBe("function");
      expect(typeof rt.back).toBe("function");
      expect(typeof rt.forward).toBe("function");
      expect(typeof rt.beforeEach).toBe("function");
      expect(typeof rt.beforeResolve).toBe("function");
      expect(typeof rt.afterEach).toBe("function");
      expect(typeof rt.isReady).toBe("boolean");
    });
  });

  describe("Route Meta and Context", () => {
    it("should handle route meta properties", async () => {
      const capturedMeta: Record<string, unknown>[] = [];

      const ComponentWithMeta = () => {
        const r = route();
        capturedMeta.push({ ...r.meta });
        return createComponent("Meta")();
      };

      setRoutes([
        {
          path: "/admin",
          component: ComponentWithMeta,
          meta: {
            requiresAuth: true,
            roles: ["admin", "moderator"],
            title: "Admin Panel",
          },
        },
      ]);

      mountRouter();

      await navigate("/admin");
      await waitForNavigation();

      const r = route();
      expect(r.meta.requiresAuth).toBe(true);
      expect(r.meta.roles).toEqual(["admin", "moderator"]);
      expect(r.meta.title).toBe("Admin Panel");
      expect(capturedMeta[capturedMeta.length - 1]).toEqual({
        requiresAuth: true,
        roles: ["admin", "moderator"],
        title: "Admin Panel",
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle navigation to non-existent routes", async () => {
      setRoutes([{ path: "/", component: createComponent("Home") }]);

      mountRouter();

      await navigate("/non-existent");
      await waitForNavigation();

      // Should stay on non-existent path but not render anything
      const r = route();
      expect(r.path).toBe("/non-existent");
      expect(document.querySelector("[data-testid]")).toBeFalsy();
    });

    it("should handle component errors gracefully", async () => {
      // Temporarily capture console.error to prevent spam
      const originalError = console.error;
      const errorLogs: unknown[] = [];
      console.error = vi.fn((error: unknown) => {
        errorLogs.push(error);
      });

      const ErrorComponent = () => {
        // Only throw error once to prevent infinite loops
        if (errorLogs.length === 0) {
          throw new Error("Component error");
        }
        return createComponent("Error")();
      };

      setRoutes([{ path: "/error", component: ErrorComponent }]);

      mountRouter();

      // Should not throw, but handle error internally
      await navigate("/error");
      await waitForNavigation();

      // Route should still be set even if component failed
      const r = route();
      expect(r.path).toBe("/error");

      // Should have captured the error
      expect(errorLogs.length).toBeGreaterThan(0);

      // Restore console.error
      console.error = originalError;
    });
  });

  describe("Edge Cases", () => {
    it("should handle duplicate navigation", async () => {
      setRoutes([{ path: "/same", component: createComponent("Same") }]);

      mountRouter();

      await navigate("/same");
      await waitForNavigation();

      const result = await navigate("/same");

      // Should detect duplicate navigation
      expect(result?.type).toBe("duplicated");
    });

    it("should handle rapid navigation changes", async () => {
      const log: string[] = [];

      setRoutes([
        { path: "/fast1", component: createComponent("Fast1", () => log.push("fast1")) },
        { path: "/fast2", component: createComponent("Fast2", () => log.push("fast2")) },
        { path: "/fast3", component: createComponent("Fast3", () => log.push("fast3")) },
      ]);

      mountRouter();

      // Fire multiple navigations rapidly
      const nav1 = navigate("/fast1");
      const nav2 = navigate("/fast2");
      const nav3 = navigate("/fast3");

      await Promise.all([nav1, nav2, nav3]);
      await waitForNavigation();

      // Should end up at the last navigation
      const r = route();
      expect(r.path).toBe("/fast3");
    });

    it("should handle special characters in routes", async () => {
      setRoutes([{ path: "/search/:query", component: createComponent("Search") }]);

      mountRouter();

      await navigate("/search/hello%20world");
      await waitForNavigation();

      const r = route();
      expect(r.path).toBe("/search/hello%20world");
      expect(r.params.query).toBe("hello world"); // Should be decoded
    });
  });
});
