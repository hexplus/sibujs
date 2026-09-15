import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropZone } from "../src/browser/dragDrop";
import { dispose, MAX_DRAIN_TEARDOWNS, registerDisposer, withDisposerRollback } from "../src/core/rendering/dispose";
import { executeLoader, loaderData, renderWithLoader, withLoader } from "../src/data/routeLoader";
import { componentAdapter } from "../src/ecosystem/ui/componentAdapter";
import { createMigrationRunner, type Migration } from "../src/plugins/versioning";
import { accordion } from "../src/widgets/Accordion";
import { tabs } from "../src/widgets/Tabs";

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Route loader data never bleeds between loaders.
// ---------------------------------------------------------------------------
describe("route loader isolation", () => {
  const ctx = { path: "/", params: {} };

  it("a later executeLoader() never becomes another route's data", () => {
    const a = executeLoader(async () => "a", ctx, { initialValue: "a" });
    const b = executeLoader(async () => "b", ctx, { initialValue: "b" });

    expect(renderWithLoader(a, () => loaderData<string>().data())).toBe("a");
    expect(() => loaderData()).toThrow(/inside a route with a loader/);
    a.dispose();
    b.dispose();
  });

  it("overlapping navigations each read their own data", async () => {
    const first = executeLoader(async () => "first", ctx);
    const second = executeLoader(async () => "second", ctx);
    const firstView = renderWithLoader(first, () => loaderData<string>());
    const secondView = renderWithLoader(second, () => loaderData<string>());
    await tick();
    expect(firstView.data()).toBe("first");
    expect(secondView.data()).toBe("second");
    first.dispose();
    second.dispose();
  });

  it("two routers rendering interleaved do not see each other's data", () => {
    const routerOne = executeLoader(async () => "", ctx, { initialValue: "one" });
    const routerTwo = executeLoader(async () => "", ctx, { initialValue: "two" });
    const seen = renderWithLoader(routerOne, () => {
      const other = renderWithLoader(routerTwo, () => loaderData<string>().data());
      return [loaderData<string>().data(), other];
    });
    expect(seen).toEqual(["one", "two"]);
    routerOne.dispose();
    routerTwo.dispose();
  });

  it("a loader disposed during render stops being readable", () => {
    const res = executeLoader(async () => "", ctx, { initialValue: "x" });
    renderWithLoader(res, () => {
      expect(loaderData<string>().data()).toBe("x");
      res.dispose();
      expect(() => loaderData()).toThrow();
    });
  });

  it("withLoader() scopes the render and disposes the resource if rendering throws", () => {
    const { view, resource } = withLoader(
      async () => "",
      ctx,
      () => loaderData<string>().data(),
      {
        initialValue: "scoped",
      },
    );
    expect(view).toBe("scoped");
    resource.dispose();

    expect(() =>
      withLoader(
        async () => "",
        ctx,
        () => {
          throw new Error("render failed");
        },
      ),
    ).toThrow("render failed");
    expect(() => loaderData()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Separate migration runners over the same storage key are serialized.
// ---------------------------------------------------------------------------
describe("migration locking across runners", () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }

  function makeStorage(): Storage {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k) => data.get(k) ?? null,
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
      setItem: (k, v) => void data.set(k, v),
    };
  }

  it("two runners sharing storage and key run each up() once", async () => {
    const storage = makeStorage();
    const g = gate();
    const up = vi.fn(async () => {
      await g.promise;
    });
    const migrations: Migration[] = [{ version: "1.0.0", description: "one", up }];
    const a = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });
    const b = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });

    const both = Promise.all([a.migrate(), b.migrate()]);
    await tick();
    g.release();
    const [ra, rb] = await both;

    expect(up).toHaveBeenCalledTimes(1);
    expect(ra.applied).toEqual(["1.0.0"]);
    expect(rb.applied).toEqual([]);
  });

  it("a failure in one runner releases the lock for the other", async () => {
    const storage = makeStorage();
    let fail = true;
    const up = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error("transient");
      }
    });
    const migrations: Migration[] = [{ version: "1.0.0", description: "one", up }];
    const a = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });
    const b = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });

    const [ra, rb] = await Promise.all([a.migrate(), b.migrate()]);
    expect(ra.errors).toHaveLength(1);
    expect(rb.applied).toEqual(["1.0.0"]);
    expect(up).toHaveBeenCalledTimes(2);
  });

  it("runners with different keys, or different storage, run independently", async () => {
    const storage = makeStorage();
    const g = gate();
    const started: string[] = [];
    const make = (key: string, store: Storage) =>
      createMigrationRunner({
        currentVersion: "1.0.0",
        storage: store,
        storageKey: key,
        migrations: [
          {
            version: "1.0.0",
            description: key,
            up: async () => {
              started.push(key);
              await g.promise;
            },
          },
        ],
      });

    const runs = Promise.all([
      make("one", storage).migrate(),
      make("two", storage).migrate(),
      make("one", makeStorage()).migrate(),
    ]);
    await tick();
    expect(started.sort()).toEqual(["one", "one", "two"]);
    g.release();
    await runs;
  });

  it("rollback on one runner waits for migrate on another", async () => {
    const storage = makeStorage();
    const g = gate();
    const log: string[] = [];
    const migrations: Migration[] = [
      {
        version: "1.0.0",
        description: "one",
        up: async () => {
          log.push("up start");
          await g.promise;
          log.push("up end");
        },
        down: () => void log.push("down"),
      },
    ];
    const a = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });
    const b = createMigrationRunner({ currentVersion: "1.0.0", storage, storageKey: "app", migrations });

    const migrating = a.migrate();
    const rolling = b.rollback("0.0.0");
    await tick();
    g.release();
    await Promise.all([migrating, rolling]);
    expect(log).toEqual(["up start", "up end", "down"]);
    expect(storage.getItem("app")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Render rollback drains cleanup registered during rollback.
// ---------------------------------------------------------------------------
describe("withDisposerRollback drains reentrant registrations", () => {
  it("a disposer registered by a rolled-back teardown runs and does not stay attached", () => {
    const node = document.createElement("div");
    const inner = vi.fn();
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, () => {
          registerDisposer(node, inner);
        });
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(inner).toHaveBeenCalledTimes(1);
    dispose(node);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("an outer failure rolls back a nested successful transaction, including its reentrant cleanup", () => {
    const node = document.createElement("div");
    const order: string[] = [];
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, () => order.push("outer"));
        withDisposerRollback(() => {
          registerDisposer(node, () => {
            order.push("nested");
            registerDisposer(node, () => order.push("nested follow-up"));
          });
        });
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(order).toEqual(["nested", "nested follow-up", "outer"]);
    dispose(node);
    expect(order).toHaveLength(3);
  });

  it("a teardown that both throws and registers cleanup still has its follow-up run", () => {
    const node = document.createElement("div");
    const followUp = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, () => {
          registerDisposer(node, followUp);
          throw new Error("teardown failed");
        });
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    dispose(node);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("runaway re-registration is bounded and reported", () => {
    const node = document.createElement("div");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let runs = 0;
    const again = () => {
      runs++;
      registerDisposer(node, again);
    };
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, again);
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(runs).toBe(MAX_DRAIN_TEARDOWNS);
    expect(consoleError.mock.calls.some((c) => String(c[0]).includes("runaway cleanup"))).toBe(true);
    consoleError.mockClear();
    // The remainder stays reachable; dispose() drains it under its own ceiling.
    dispose(node);
  });
});

// ---------------------------------------------------------------------------
// Keyboard checks see framework handlers in the production build.
// ---------------------------------------------------------------------------
const DIST_INDEX = resolve(__dirname, "../dist/index.js");
const DIST_TESTING = resolve(__dirname, "../dist/testing.js");
const distBuilt = existsSync(DIST_INDEX) && existsSync(DIST_TESTING);

describe.skipIf(!distBuilt)("checkKeyboardAccess against the production build", () => {
  it("reports on.click from tagFactory and on:click from html", async () => {
    // Loading dist next to source is a deliberate duplicate instance.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const testing = await import(/* @vite-ignore */ DIST_TESTING);
    const core = await import(/* @vite-ignore */ DIST_INDEX);

    const fromFactory = core.div({ on: { click() {} } }, "Click") as HTMLElement;
    expect(testing.checkKeyboardAccess(fromFactory).some((v: { level: string }) => v.level === "error")).toBe(true);

    const fromHtml = core.html`<div on:click=${() => {}}>Click</div>` as HTMLElement;
    expect(testing.checkKeyboardAccess(fromHtml).some((v: { level: string }) => v.level === "error")).toBe(true);

    const accessible = core.div(
      { role: "button", tabindex: "0", on: { click() {}, keydown() {} } },
      "OK",
    ) as HTMLElement;
    expect(testing.checkKeyboardAccess(accessible).filter((v: { level: string }) => v.level === "error")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Theme CSS variables restore what the element had before.
// ---------------------------------------------------------------------------
describe("theme.applyTo() restores pre-existing properties", () => {
  const config = { name: "t", prefix: "t", components: {} };

  it("restores the original value and priority on release", () => {
    const { theme } = componentAdapter(config);
    const root = document.createElement("div");
    root.style.setProperty("--accent", "original");
    // jsdom does not keep priorities on custom properties, so report the
    // original one and observe what the release writes back.
    vi.spyOn(root.style, "getPropertyPriority").mockImplementation((name) => (name === "--accent" ? "important" : ""));
    const setProperty = vi.spyOn(root.style, "setProperty");
    theme.setTheme({ variables: { "--accent": "theme" } });

    const release = theme.applyTo(root);
    expect(root.style.getPropertyValue("--accent")).toBe("theme");
    release();

    expect(root.style.getPropertyValue("--accent")).toBe("original");
    expect(setProperty).toHaveBeenLastCalledWith("--accent", "original", "important");
  });

  it("restores the original when the theme drops the variable, and keeps the first snapshot across updates", () => {
    const { theme } = componentAdapter(config);
    const root = document.createElement("div");
    root.style.setProperty("--accent", "original");
    theme.setTheme({ variables: { "--accent": "one" } });
    const release = theme.applyTo(root);

    theme.setTheme({ variables: { "--accent": "two" } });
    expect(root.style.getPropertyValue("--accent")).toBe("two");

    theme.setTheme({ variables: {} });
    expect(root.style.getPropertyValue("--accent")).toBe("original");

    theme.setTheme({ variables: { "--accent": "three" } });
    expect(root.style.getPropertyValue("--accent")).toBe("three");
    release();
    expect(root.style.getPropertyValue("--accent")).toBe("original");
  });

  it("repeated application on one root unwinds in reverse", () => {
    const first = componentAdapter(config).theme;
    const second = componentAdapter(config).theme;
    const root = document.createElement("div");
    root.style.setProperty("--accent", "original");
    first.setTheme({ variables: { "--accent": "first" } });
    second.setTheme({ variables: { "--accent": "second" } });

    const releaseFirst = first.applyTo(root);
    const releaseSecond = second.applyTo(root);
    expect(root.style.getPropertyValue("--accent")).toBe("second");
    releaseSecond();
    expect(root.style.getPropertyValue("--accent")).toBe("first");
    releaseFirst();
    expect(root.style.getPropertyValue("--accent")).toBe("original");

    const releaseAgain = first.applyTo(root);
    releaseAgain();
    releaseAgain();
    expect(root.style.getPropertyValue("--accent")).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// dropZone clears hover when the drag leaves to nowhere.
// ---------------------------------------------------------------------------
describe("dropZone exit with a null or foreign destination", () => {
  let zone: HTMLElement;
  let child: HTMLElement;
  beforeEach(() => {
    zone = document.createElement("div");
    child = document.createElement("span");
    zone.appendChild(child);
    document.body.appendChild(zone);
  });
  const fire = (el: Element, type: string, relatedTarget: unknown) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "relatedTarget", { value: relatedTarget });
    el.dispatchEvent(e);
  };

  it("a null destination after nested enters ends the hover", () => {
    const dz = dropZone(() => zone, { onDrop: () => {} });
    fire(zone, "dragenter", document.body);
    fire(child, "dragenter", zone);
    fire(child, "dragleave", null);
    expect(dz.isOver()).toBe(false);
    dz.dispose();
  });

  it("a destination in another document ends the hover", () => {
    const dz = dropZone(() => zone, { onDrop: () => {} });
    const foreign = document.implementation.createHTMLDocument("other").body;
    fire(zone, "dragenter", document.body);
    fire(child, "dragenter", zone);
    fire(child, "dragleave", foreign);
    expect(dz.isOver()).toBe(false);
    dz.dispose();
  });

  it("a non-node destination ends the hover; moving inside keeps it", () => {
    const dz = dropZone(() => zone, { onDrop: () => {} });
    fire(zone, "dragenter", document.body);
    fire(child, "dragenter", zone);
    fire(zone, "dragleave", child);
    expect(dz.isOver()).toBe(true);
    fire(child, "dragleave", window);
    expect(dz.isOver()).toBe(false);

    // A fresh drag starts from a clean depth.
    fire(zone, "dragenter", document.body);
    expect(dz.isOver()).toBe(true);
    dz.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tabs and Accordion restore author ARIA state on teardown.
// ---------------------------------------------------------------------------
describe("widget teardown restores author ARIA", () => {
  function tabMarkup() {
    const tablist = document.createElement("div");
    const one = document.createElement("button");
    const two = document.createElement("button");
    const panelOne = document.createElement("div");
    const panelTwo = document.createElement("div");
    one.setAttribute("aria-selected", "false");
    one.setAttribute("tabindex", "3");
    two.setAttribute("aria-selected", "true");
    two.setAttribute("aria-disabled", "true");
    panelOne.setAttribute("hidden", "");
    tablist.append(one, two, panelOne, panelTwo);
    document.body.appendChild(tablist);
    return { tablist, one, two, panelOne, panelTwo };
  }
  const attrs = (el: Element) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));

  it("Tabs restores pre-existing aria-selected, tabindex, aria-disabled and hidden", () => {
    const m = tabMarkup();
    const before = [m.tablist, m.one, m.two, m.panelOne, m.panelTwo].map(attrs);
    const t = tabs({
      tabs: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    });
    const teardown = t.bind({
      tablist: m.tablist,
      tabs: { one: m.one, two: m.two },
      panels: { one: m.panelOne, two: m.panelTwo },
    });

    expect(m.one.getAttribute("aria-selected")).toBe("true");
    expect(m.one.getAttribute("tabindex")).toBe("0");
    teardown();

    expect([m.tablist, m.one, m.two, m.panelOne, m.panelTwo].map(attrs)).toEqual(before);
  });

  it("Tabs reconciles aria-disabled with the definition in both directions", () => {
    const m = tabMarkup();
    const t = tabs({
      tabs: [
        { id: "one", label: "One", disabled: true },
        { id: "two", label: "Two" },
      ],
    });
    const teardown = t.bind({ tablist: m.tablist, tabs: { one: m.one, two: m.two } });

    expect(m.one.getAttribute("aria-disabled")).toBe("true");
    expect(m.two.hasAttribute("aria-disabled")).toBe(false);
    teardown();
    expect(m.one.hasAttribute("aria-disabled")).toBe(false);
    expect(m.two.getAttribute("aria-disabled")).toBe("true");
  });

  it("Tabs rebinding after teardown starts from, and returns to, the author state", () => {
    const m = tabMarkup();
    const before = [m.one, m.two].map(attrs);
    const t = tabs({
      tabs: [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
      ],
    });
    const els = { tablist: m.tablist, tabs: { one: m.one, two: m.two } };

    t.bind(els)();
    const teardown = t.bind(els);
    t.setActiveTab("two");
    expect(m.two.getAttribute("aria-selected")).toBe("true");
    teardown();
    expect([m.one, m.two].map(attrs)).toEqual(before);
  });

  it("Accordion restores pre-existing aria-expanded and hidden", () => {
    const root = document.createElement("div");
    const trigger = document.createElement("button");
    const panel = document.createElement("div");
    trigger.setAttribute("aria-expanded", "true");
    panel.setAttribute("role", "group");
    root.append(trigger, panel);
    document.body.appendChild(root);
    const before = [trigger, panel].map(attrs);

    const acc = accordion({ items: [{ id: "a", label: "A" }] });
    const els = { root, triggers: { a: trigger }, panels: { a: panel } };
    acc.bind(els)();
    const teardown = acc.bind(els);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    teardown();

    expect([trigger, panel].map(attrs)).toEqual(before);
  });
});
