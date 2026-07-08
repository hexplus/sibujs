import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, destroyRouter, route } from "../src/plugins/router";

// Regression: the initial navigation to "/" must actually resolve the match.
//
// The router seeds `currentRoute` with a placeholder { path: "/", matched: [] }
// and then, on init, navigates to the current path. For the root path the
// placeholder and the real target share path/params/query/hash, so the
// `isSameRoute` dedup wrongly treated them as identical ("duplicated") and
// discarded the real match — leaving `route().matched` empty forever.
describe("Router: initial match on '/'", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
  });

  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  it("populates route().matched for the root path after init", async () => {
    const Landing = () => document.createElement("div");
    const About = () => document.createElement("div");

    createRouter(
      [
        { path: "/", component: Landing },
        { path: "/about", component: About },
      ],
      { mode: "history" },
    );

    await wait();

    const current = route();
    expect(current.path).toBe("/");
    expect(current.matched.length).toBeGreaterThan(0);
    expect(current.matched[current.matched.length - 1].component).toBe(Landing);
  });
});
