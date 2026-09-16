import { createRouter, destroyRouter, type NavigationTarget, navigate, route } from "../../src/plugins/router";

export { destroyRouter };

/** A router with one `/callback` route, and a helper that navigates and returns the resulting route. */
export function createNavigation() {
  window.history.replaceState({}, "", "/");
  createRouter([
    { path: "/", component: () => document.createElement("div") },
    { path: "/callback", component: () => document.createElement("div") },
  ]);
  return {
    async go(target: NavigationTarget) {
      await navigate(target);
      const r = route();
      return { path: r.path, query: { ...r.query }, hash: r.hash };
    },
  };
}
