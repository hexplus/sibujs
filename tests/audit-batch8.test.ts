import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInSSRContext } from "../src/core/ssr-context";
import { executeLoader, loaderData, renderWithLoader } from "../src/data/routeLoader";
import { compareSemVer, createMigrationRunner, VERSION } from "../src/plugins/versioning";
import { createListbox } from "../src/ui/a11yPrimitives";

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// 87. VERSION reports the real package version.
// ---------------------------------------------------------------------------
describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

// ---------------------------------------------------------------------------
// 88. Build metadata never affects SemVer precedence.
// ---------------------------------------------------------------------------
describe("compareSemVer build metadata", () => {
  it("ignores build metadata, with and without prerelease", () => {
    expect(compareSemVer("1.0.0-alpha+build-a", "1.0.0-alpha+build-b")).toBe(0);
    expect(compareSemVer("1.0.0+20130313144700", "1.0.0+exp.sha.5114f85")).toBe(0);
    expect(compareSemVer("1.0.0+z", "1.0.1+a")).toBe(-1);
  });

  it("follows the SemVer 2.0.0 precedence example", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareSemVer(ordered[i], ordered[i + 1])).toBe(-1);
      expect(compareSemVer(ordered[i + 1], ordered[i])).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 90. rollback() preflights every down() before mutating anything.
// ---------------------------------------------------------------------------
describe("rollback preflight", () => {
  const KEY = "__batch8_migrations__";
  beforeEach(() => localStorage.clear());

  it("a missing down() after a valid newer handler runs nothing", async () => {
    const down12 = vi.fn();
    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      storageKey: KEY,
      migrations: [
        { version: "1.0.0", description: "base", up: () => {}, down: () => {} },
        { version: "1.1.0", description: "irreversible", up: () => {} },
        { version: "1.2.0", description: "newest", up: () => {}, down: down12 },
      ],
    });
    localStorage.setItem(KEY, "1.2.0");

    await expect(runner.rollback("1.0.0")).rejects.toThrow(/1\.1\.0.*does not have a down\(\)/);

    expect(down12).not.toHaveBeenCalled();
    expect(runner.getAppliedVersion()).toBe("1.2.0");
  });

  it("failure on the first rollback leaves storage untouched", async () => {
    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      storageKey: KEY,
      migrations: [
        { version: "1.1.0", description: "a", up: () => {}, down: () => {} },
        {
          version: "1.2.0",
          description: "b",
          up: () => {},
          down: () => {
            throw new Error("first failed");
          },
        },
      ],
    });
    localStorage.setItem(KEY, "1.2.0");

    await expect(runner.rollback("1.0.0")).rejects.toThrow("first failed");
    expect(runner.getAppliedVersion()).toBe("1.2.0");
  });

  it("failure on the last rollback checkpoints everything before it", async () => {
    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      storageKey: KEY,
      migrations: [
        {
          version: "1.0.0",
          description: "a",
          up: () => {},
          down: () => {
            throw new Error("last failed");
          },
        },
        { version: "1.1.0", description: "b", up: () => {}, down: () => {} },
        { version: "1.2.0", description: "c", up: () => {}, down: () => {} },
      ],
    });
    localStorage.setItem(KEY, "1.2.0");

    await expect(runner.rollback("0.0.0")).rejects.toThrow("last failed");
    expect(runner.getAppliedVersion()).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// 93. Route loader data is scoped to the route that rendered, and per request.
// ---------------------------------------------------------------------------
describe("route loader scoping", () => {
  it("a component rendered for route A reads A's data even after B executed", async () => {
    const routeA = executeLoader(async () => "A", { path: "/a", params: {} });
    const routeB = executeLoader(async () => "B", { path: "/b", params: {} });
    await tick();

    const seenByA = renderWithLoader(routeA, () => loaderData<string>().data());
    const seenByB = renderWithLoader(routeB, () => loaderData<string>().data());

    expect(seenByA).toBe("A");
    expect(seenByB).toBe("B");
    routeA.dispose();
    routeB.dispose();
  });

  it("nested routes see their own data and the parent's is restored afterwards", async () => {
    const parent = executeLoader(async () => "parent", { path: "/p", params: {} });
    const child = executeLoader(async () => "child", { path: "/p/c", params: {} });
    await tick();

    const seen = renderWithLoader(parent, () => {
      const before = loaderData<string>().data();
      const inner = renderWithLoader(child, () => loaderData<string>().data());
      const after = loaderData<string>().data();
      return { before, inner, after };
    });

    expect(seen).toEqual({ before: "parent", inner: "child", after: "parent" });
    parent.dispose();
    child.dispose();
  });

  it("the render scope is restored even when rendering throws", async () => {
    const outer = executeLoader(async () => "outer", { path: "/o", params: {} });
    const failing = executeLoader(async () => "failing", { path: "/f", params: {} });
    await tick();

    renderWithLoader(outer, () => {
      expect(() =>
        renderWithLoader(failing, () => {
          throw new Error("render failed");
        }),
      ).toThrow("render failed");
      expect(loaderData<string>().data()).toBe("outer");
    });
    outer.dispose();
    failing.dispose();
  });

  it("a disposed loader is no longer readable", async () => {
    const old = executeLoader(async () => "old", { path: "/old", params: {} });
    await tick();
    expect(renderWithLoader(old, () => loaderData<string>().data())).toBe("old");

    old.dispose();

    expect(() => renderWithLoader(old, () => loaderData())).toThrow(/disposed/);
    expect(() => loaderData()).toThrow(/loaderData must be used inside a route with a loader/);
  });

  it("disposing another loader does not affect the current scope", async () => {
    const first = executeLoader(async () => "first", { path: "/1", params: {} });
    const second = executeLoader(async () => "second", { path: "/2", params: {} });
    await tick();

    first.dispose();

    expect(renderWithLoader(second, () => loaderData<string>().data())).toBe("second");
    second.dispose();
  });

  it("concurrent SSR requests never see each other's loader data", async () => {
    const request = (value: string) =>
      runInSSRContext(async () => {
        const res = executeLoader(async () => value, { path: `/${value}`, params: {} }, { initialValue: value });
        await tick();
        const seen = renderWithLoader(res, () => loaderData<string>().data());
        res.dispose();
        return seen;
      });

    const [a, b] = await Promise.all([request("request-a"), request("request-b")]);
    expect(a).toBe("request-a");
    expect(b).toBe("request-b");
  });

  it("a server request's loader does not leak into the client scope", async () => {
    await runInSSRContext(async () => {
      executeLoader(async () => "server", { path: "/s", params: {} }, { initialValue: "server" });
    });
    expect(() => loaderData()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 94. createListbox() never activates or selects disabled options.
// ---------------------------------------------------------------------------
describe("createListbox disabled options", () => {
  function make(markup: string, options: Parameters<typeof createListbox>[1] = {}) {
    const ul = document.createElement("ul");
    ul.innerHTML = markup;
    document.body.appendChild(ul);
    const onSelect = vi.fn();
    const lb = createListbox(ul, { ...options, onSelect });
    const key = (k: string) => ul.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    return { ul, lb, onSelect, key };
  }
  const opt = (v: string, disabled = false) =>
    `<li role="option" data-value="${v}"${disabled ? ' aria-disabled="true"' : ""}>${v}</li>`;

  it("arrow navigation skips disabled options, including on wraparound", () => {
    const { lb, key } = make(opt("a", true) + opt("b") + opt("c", true) + opt("d"));
    key("ArrowDown");
    expect(lb.activeValue()).toBe("b");
    key("ArrowDown");
    expect(lb.activeValue()).toBe("d");
    key("ArrowDown");
    expect(lb.activeValue()).toBe("b");
    key("ArrowUp");
    expect(lb.activeValue()).toBe("d");
    lb.dispose();
  });

  it("Home and End go to the first and last enabled options", () => {
    const { lb, key } = make(opt("a", true) + opt("b") + opt("c") + opt("d", true));
    key("End");
    expect(lb.activeValue()).toBe("c");
    key("Home");
    expect(lb.activeValue()).toBe("b");
    lb.dispose();
  });

  it("clicking a disabled option neither activates nor selects it", () => {
    const { ul, lb, onSelect } = make(opt("a", true) + opt("b"));
    ul.querySelector<HTMLElement>('[data-value="a"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lb.selectedValues()).toEqual([]);
    expect(lb.activeValue()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(ul.querySelector('[data-value="a"]')!.getAttribute("aria-selected")).toBe("false");
    lb.dispose();
  });

  it("Enter on an option that became disabled does not select it", () => {
    const { ul, lb, onSelect, key } = make(opt("a") + opt("b"));
    key("ArrowDown");
    expect(lb.activeValue()).toBe("a");
    ul.querySelector('[data-value="a"]')!.setAttribute("aria-disabled", "true");
    key("Enter");
    expect(lb.selectedValues()).toEqual([]);
    expect(onSelect).not.toHaveBeenCalled();
    lb.dispose();
  });

  it("an all-disabled listbox has no active option", () => {
    const { lb, key } = make(opt("a", true) + opt("b", true));
    key("ArrowDown");
    key("Home");
    key("End");
    expect(lb.activeValue()).toBeNull();
    lb.dispose();
  });

  it("honors a custom option selector", () => {
    const ul = document.createElement("div");
    ul.innerHTML =
      '<span class="o" data-value="x" aria-disabled="true">x</span><span class="o" data-value="y">y</span>';
    document.body.appendChild(ul);
    const lb = createListbox(ul, { optionSelector: ".o" });
    ul.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lb.activeValue()).toBe("y");
    lb.dispose();
  });
});
