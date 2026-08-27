/**
 * Head/title/base singleton-resource ownership.
 *
 * `document.title` and `<base>` are GLOBAL singleton resources: only one owner
 * can be effective at a time, and disposal must hand control back to whoever
 * held it before — not to a stale per-instance snapshot, and not to nothing.
 *
 * A per-instance `previousTitle` snapshot is provably insufficient: with three
 * overlapping owners, disposing the middle one restores a title that is no
 * longer current.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { title } from "../src/browser/title";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { Head } from "../src/platform/head";

const ORIGINAL = "Original Document Title";

beforeEach(() => {
  document.title = ORIGINAL;
  for (const el of Array.from(document.head.querySelectorAll("base, meta, link, script"))) el.remove();
});

afterEach(() => {
  document.title = ORIGINAL;
  for (const el of Array.from(document.head.querySelectorAll("base, meta, link, script"))) el.remove();
});

describe("title() — owner stack", () => {
  it("restores the original title on dispose", () => {
    const releaseA = title("Dashboard");
    expect(document.title).toBe("Dashboard");
    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });

  it("hands back to the previous owner when the newest is disposed", () => {
    const releaseA = title("Dashboard");
    const releaseB = title("Settings");
    expect(document.title).toBe("Settings");

    releaseB();
    expect(document.title).toBe("Dashboard");

    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });

  it("survives out-of-order disposal (A, B, C → dispose B)", () => {
    const releaseA = title("A");
    const releaseB = title("B");
    const releaseC = title("C");
    expect(document.title).toBe("C");

    // Disposing a NON-active owner must not touch the active title.
    releaseB();
    expect(document.title).toBe("C");

    releaseC();
    // B is gone, so control returns to A — not to B's stale snapshot.
    expect(document.title).toBe("A");

    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });

  it("is idempotent when a release runs twice", () => {
    const releaseA = title("A");
    const releaseB = title("B");

    releaseB();
    releaseB();
    expect(document.title).toBe("A");

    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });

  it("tracks a reactive title while it owns the resource", () => {
    const [name, setName] = signal("One");
    const releaseA = title(() => name());
    expect(document.title).toBe("One");

    setName("Two");
    expect(document.title).toBe("Two");

    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });

  it("does not let a superseded reactive owner write the title", () => {
    const [name, setName] = signal("One");
    const releaseA = title(() => name());
    const releaseB = title("B");
    expect(document.title).toBe("B");

    setName("Two");
    // A is no longer the active owner — its update must not win.
    expect(document.title).toBe("B");

    releaseB();
    expect(document.title).toBe("Two");
    releaseA();
    expect(document.title).toBe(ORIGINAL);
  });
});

describe("Head() — title ownership", () => {
  it("restores the previous title when the Head is disposed", () => {
    const head = Head({ title: "Dashboard" });
    expect(document.title).toBe("Dashboard");

    dispose(head);
    expect(document.title).toBe(ORIGINAL);
  });

  it("shares one title manager with title()", () => {
    const head = Head({ title: "HeadTitle" });
    const releaseB = title("HelperTitle");
    expect(document.title).toBe("HelperTitle");

    dispose(head);
    // The Head is not the active owner; the helper keeps the title.
    expect(document.title).toBe("HelperTitle");

    releaseB();
    expect(document.title).toBe(ORIGINAL);
  });

  it("returns control to a Head when a later helper releases", () => {
    const head = Head({ title: "HeadTitle" });
    const releaseB = title("HelperTitle");

    releaseB();
    expect(document.title).toBe("HeadTitle");

    dispose(head);
    expect(document.title).toBe(ORIGINAL);
  });

  it("restores the original title after a reactive Head title is disposed", () => {
    const [t, setT] = signal("First");
    const head = Head({ title: () => t() });
    expect(document.title).toBe("First");

    setT("Second");
    expect(document.title).toBe("Second");

    dispose(head);
    expect(document.title).toBe(ORIGINAL);
  });
});

describe("Head() — base ownership", () => {
  function serverBase(href: string): HTMLBaseElement {
    const el = document.createElement("base");
    el.setAttribute("href", href);
    document.head.appendChild(el);
    return el;
  }

  function activeBaseHref(): string | null {
    const el = document.head.querySelector("base");
    return el ? el.getAttribute("href") : null;
  }

  it("restores the server-rendered base when the Head is disposed", () => {
    serverBase("https://server.example/app/");

    const head = Head({ base: { href: "https://head.example/a/" } });
    expect(activeBaseHref()).toBe("https://head.example/a/");

    dispose(head);
    expect(activeBaseHref()).toBe("https://server.example/app/");
  });

  it("keeps exactly one effective base element at a time", () => {
    serverBase("https://server.example/app/");
    const head = Head({ base: { href: "https://head.example/a/" } });

    expect(document.head.querySelectorAll("base").length).toBe(1);

    dispose(head);
    expect(document.head.querySelectorAll("base").length).toBe(1);
  });

  it("hands the base back down the owner stack", () => {
    serverBase("https://server.example/app/");
    const headA = Head({ base: { href: "https://a.example/" } });
    const headB = Head({ base: { href: "https://b.example/" } });
    expect(activeBaseHref()).toBe("https://b.example/");

    dispose(headB);
    expect(activeBaseHref()).toBe("https://a.example/");

    dispose(headA);
    expect(activeBaseHref()).toBe("https://server.example/app/");
  });

  it("survives out-of-order base disposal", () => {
    serverBase("https://server.example/app/");
    const headA = Head({ base: { href: "https://a.example/" } });
    const headB = Head({ base: { href: "https://b.example/" } });
    const headC = Head({ base: { href: "https://c.example/" } });

    dispose(headB);
    expect(activeBaseHref()).toBe("https://c.example/");

    dispose(headC);
    expect(activeBaseHref()).toBe("https://a.example/");

    dispose(headA);
    expect(activeBaseHref()).toBe("https://server.example/app/");
  });

  it("removes its base entirely when there was no original", () => {
    const head = Head({ base: { href: "https://a.example/" } });
    expect(activeBaseHref()).toBe("https://a.example/");

    dispose(head);
    expect(document.head.querySelector("base")).toBeNull();
  });

  it("still sanitizes a dangerous base href", () => {
    const head = Head({ base: { href: "javascript:alert(1)" } });
    const el = document.head.querySelector("base");
    expect(el?.getAttribute("href") ?? "").not.toContain("javascript:");
    dispose(head);
  });
});

describe("Head() — ordinary tags keep independent cleanup", () => {
  it("removes only its own meta/link/script on dispose", () => {
    const headA = Head({ meta: [{ name: "description", content: "A" }] });
    const headB = Head({ meta: [{ name: "keywords", content: "B" }] });

    expect(document.head.querySelector('meta[name="description"]')).not.toBeNull();
    expect(document.head.querySelector('meta[name="keywords"]')).not.toBeNull();

    dispose(headA);
    expect(document.head.querySelector('meta[name="description"]')).toBeNull();
    expect(document.head.querySelector('meta[name="keywords"]')).not.toBeNull();

    dispose(headB);
    expect(document.head.querySelector('meta[name="keywords"]')).toBeNull();
  });
});
