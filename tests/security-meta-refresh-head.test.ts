/**
 * `Head()` meta entries must be validated as COMPLETE SNAPSHOTS.
 *
 * The old implementation created one effect per reactive attribute, so each
 * write was judged on its own. That lets a combination become dangerous even
 * though no individual write ever looked wrong:
 *
 *     http-equiv: () => equiv()      // "x-custom" initially — not a refresh
 *     content:    "0;url=javascript:alert(1)"   // static, accepted on that basis
 *
 * then `setEquiv("refresh")` re-runs only the `http-equiv` effect. The static
 * content is never revalidated, and the element is now a live redirect.
 *
 * The fix is transactional: one effect per ENTRY resolves every attribute,
 * validates the assembled snapshot, and only then reconciles the element.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { Head } from "../src/platform/head";
import { batch } from "../src/reactivity/batch";

const DANGEROUS = "0;url=javascript:alert(1)";
const DANGEROUS_SPACED = "0; url = javascript:alert(1)";
const SAFE = "5;url=/home";

/** Every meta element currently live in the document head. */
function metas(): HTMLMetaElement[] {
  return Array.from(document.head.querySelectorAll("meta"));
}

/** Is there an ACTIVE refresh directive the browser would honour? */
function activeRefresh(): HTMLMetaElement | undefined {
  return metas().find((m) => (m.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh");
}

function assertNoDangerousRefresh(): void {
  const live = activeRefresh();
  if (!live) return;
  const content = (live.getAttribute("content") ?? "").toLowerCase();
  expect(content, "a live refresh points at a dangerous destination").not.toMatch(/javascript:|data:|vbscript:|blob:/);
}

beforeEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

describe("reactive http-equiv with static dangerous content", () => {
  it("cannot become an active dangerous refresh", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS }] });

    // Initially harmless: not a refresh directive at all.
    expect(activeRefresh()).toBeUndefined();

    setEquiv("refresh");

    // The static content was accepted on the basis of a snapshot that is no
    // longer true, so the entry must not be live now.
    assertNoDangerousRefresh();
    dispose(head);
  });

  it("cannot become dangerous through a whitespace-spelled destination", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS_SPACED }] });

    setEquiv("refresh");
    assertNoDangerousRefresh();
    dispose(head);
  });

  it("leaves no detached-but-counted element behind", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS }] });
    setEquiv("refresh");

    // Whatever the implementation does internally, the document must not hold
    // a dangerous directive.
    expect(metas().filter((m) => (m.getAttribute("content") ?? "").includes("javascript:"))).toHaveLength(0);
    dispose(head);
  });
});

describe("reactive http-equiv with static SAFE content", () => {
  it("becomes a valid refresh directive", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: SAFE }] });

    setEquiv("refresh");

    const live = activeRefresh();
    expect(live, "a safe refresh was suppressed").toBeDefined();
    expect(live?.getAttribute("content")).toBe(SAFE);
    dispose(head);
  });
});

describe("static refresh with reactive content", () => {
  it("goes safe → dangerous → safe without ever being live while dangerous", () => {
    const [content, setContent] = signal(SAFE);
    const head = Head({ meta: [{ "http-equiv": "refresh", content: () => content() }] });

    expect(activeRefresh()?.getAttribute("content")).toBe(SAFE);

    setContent(DANGEROUS);
    assertNoDangerousRefresh();

    setContent("10;url=/next");
    const restored = activeRefresh();
    expect(restored, "a safe directive was not restored").toBeDefined();
    expect(restored?.getAttribute("content")).toBe("10;url=/next");

    // Reinstating must not duplicate the managed element.
    expect(metas()).toHaveLength(1);
    dispose(head);
  });

  it("does not accumulate duplicates across repeated transitions", () => {
    const [content, setContent] = signal(SAFE);
    const head = Head({ meta: [{ "http-equiv": "refresh", content: () => content() }] });

    for (let i = 0; i < 5; i++) {
      setContent(DANGEROUS);
      setContent(`${i};url=/page-${i}`);
    }

    expect(metas()).toHaveLength(1);
    expect(activeRefresh()?.getAttribute("content")).toBe("4;url=/page-4");
    dispose(head);
  });
});

describe("both values reactive", () => {
  const transition = (batched: boolean) => {
    const [equiv, setEquiv] = signal("x-custom");
    const [content, setContent] = signal(DANGEROUS);
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: () => content() }] });

    const step = (fn: () => void) => {
      if (batched) batch(fn);
      else fn();
      assertNoDangerousRefresh();
    };

    // non-refresh + dangerous → safe at every observable step
    assertNoDangerousRefresh();

    // → refresh + safe
    step(() => {
      setEquiv("refresh");
      setContent(SAFE);
    });
    expect(activeRefresh()?.getAttribute("content")).toBe(SAFE);

    // → refresh + dangerous
    step(() => {
      setContent(DANGEROUS);
    });

    // → non-refresh + dangerous
    step(() => {
      setEquiv("x-custom");
    });

    dispose(head);
  };

  it("stays safe through every transition (unbatched)", () => {
    transition(false);
  });

  it("stays safe through every transition (batched)", () => {
    transition(true);
  });

  it("never leaves a dangerous pair live even mid-sequence", () => {
    const [equiv, setEquiv] = signal("refresh");
    const [content, setContent] = signal(SAFE);
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: () => content() }] });

    // Change content to dangerous FIRST, while http-equiv is already refresh.
    setContent(DANGEROUS);
    assertNoDangerousRefresh();

    // Then make it non-refresh, then refresh again while still dangerous.
    setEquiv("x-custom");
    assertNoDangerousRefresh();
    setEquiv("refresh");
    assertNoDangerousRefresh();

    dispose(head);
  });
});

describe("attribute reconciliation", () => {
  it("updates changed values in place rather than appending", () => {
    const [desc, setDesc] = signal("first");
    const head = Head({ meta: [{ name: "description", content: () => desc() }] });

    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("content")).toBe("first");

    setDesc("second");
    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("content")).toBe("second");
    dispose(head);
  });

  it("preserves unrelated safe attributes across an unsafe transition", () => {
    const [content, setContent] = signal(SAFE);
    const head = Head({
      meta: [{ "http-equiv": "refresh", content: () => content(), id: "keeper" }],
    });

    expect(activeRefresh()?.getAttribute("id")).toBe("keeper");

    setContent(DANGEROUS);
    assertNoDangerousRefresh();

    setContent(SAFE);
    expect(activeRefresh()?.getAttribute("id"), "an unrelated attribute was lost").toBe("keeper");
    dispose(head);
  });

  it("keeps ordinary description/keyword/OG metas working", () => {
    const head = Head({
      meta: [
        { name: "description", content: "A page" },
        { name: "keywords", content: "a,b" },
        { property: "og:title", content: "Title" },
      ],
    });

    expect(metas()).toHaveLength(3);
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("A page");
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe("Title");
    dispose(head);
  });
});

describe("duplicate case-insensitive names in Head()", () => {
  it("refuses an entry with two http-equiv spellings", () => {
    const head = Head({
      meta: [{ "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: DANGEROUS }],
    });
    assertNoDangerousRefresh();
    dispose(head);
  });

  it("refuses an entry with two content spellings", () => {
    const head = Head({
      meta: [{ "HTTP-EQUIV": "refresh", content: SAFE, CONTENT: "0;url=data:text/html,x" }],
    });
    assertNoDangerousRefresh();
    dispose(head);
  });
});

describe("disposal", () => {
  it("stops every effect and leaves nothing behind", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const [content, setContent] = signal(SAFE);
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: () => content() }] });

    expect(metas()).toHaveLength(1);
    dispose(head);
    expect(metas()).toHaveLength(0);

    // Updating afterwards must neither resurrect nor mutate anything.
    setEquiv("refresh");
    setContent(DANGEROUS);
    expect(metas()).toHaveLength(0);
  });
});
