import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { urlState } from "../src/browser/urlState";

// ---------------------------------------------------------------------------
// urlState(): history.state survives URL writes, and every live instance sees
// every framework URL write.
//
// THE DEFECTS:
// 1. setParams()/setHash() passed `null` as the state to pushState/replaceState,
//    erasing router metadata, scroll restoration data and application state
//    attached to the history entry.
// 2. Setters updated only their own instance's signals. History API writes do
//    not fire `popstate`, so other mounted instances kept reporting the old URL.
// ---------------------------------------------------------------------------

const instances: ReturnType<typeof urlState>[] = [];
function create() {
  const url = urlState();
  instances.push(url);
  return url;
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  for (const url of instances.splice(0)) url.dispose();
  history.replaceState(null, "", "/");
});

describe("urlState preserves history.state", () => {
  it("setParams({ replace: true }) preserves object state", () => {
    const state = { navigationId: 7, scroll: { y: 120 } };
    history.replaceState(state, "", "/");
    const url = create();

    url.setParams({ q: "test" }, { replace: true });

    expect(location.search).toBe("?q=test");
    expect(history.state).toEqual(state);
  });

  it("setHash({ replace: true }) preserves state", () => {
    history.replaceState({ navigationId: 3 }, "", "/");
    const url = create();

    url.setHash("settings", { replace: true });

    expect(location.hash).toBe("#settings");
    expect(history.state).toEqual({ navigationId: 3 });
  });

  it("a pushed entry carries the current state forward", () => {
    history.replaceState({ navigationId: 9 }, "", "/");
    const url = create();
    const lengthBefore = history.length;

    url.setParams({ page: "2" });
    url.setHash("details");

    expect(history.length).toBe(lengthBefore + 2);
    expect(history.state).toEqual({ navigationId: 9 });
  });

  for (const falsy of [0, false, ""] as const) {
    it(`preserves the falsy state ${JSON.stringify(falsy)} exactly`, () => {
      history.replaceState(falsy, "", "/");
      const url = create();

      url.setParams({ a: "1" }, { replace: true });
      expect(history.state).toBe(falsy);
      url.setHash("x");
      expect(history.state).toBe(falsy);
    });
  }

  it("an explicit `state` option replaces the entry's state", () => {
    history.replaceState({ old: true }, "", "/");
    const url = create();

    url.setParams({ q: "1" }, { replace: true, state: { fresh: 1 } });
    expect(history.state).toEqual({ fresh: 1 });

    url.setHash("h", { state: null });
    expect(history.state).toBeNull();
  });
});

describe("urlState instances stay in sync", () => {
  for (const replace of [false, true]) {
    const mode = replace ? "replace" : "push";

    it(`two instances synchronize after setParams() (${mode})`, () => {
      const a = create();
      const b = create();

      a.setParams({ q: "shared" }, { replace });

      expect(a.params().get("q")).toBe("shared");
      expect(b.params().get("q")).toBe("shared");
    });

    it(`two instances synchronize after setHash() (${mode})`, () => {
      const a = create();
      const b = create();

      a.setHash("settings", { replace });

      expect(a.hash()).toBe("#settings");
      expect(b.hash()).toBe("#settings");
    });
  }

  it("a disposed instance stops receiving updates", () => {
    const a = create();
    const b = create();
    b.dispose();

    a.setParams({ q: "after" });
    a.setHash("later");

    expect(b.params().get("q")).toBeNull();
    expect(b.hash()).toBe("");
  });

  it("dispose() is idempotent", () => {
    const a = create();
    const b = create();
    b.dispose();
    b.dispose();

    a.setHash("still-works");
    expect(a.hash()).toBe("#still-works");
  });
});
