/**
 * `Head()` meta entries: whole-snapshot validation, ATOMIC publication, and the
 * static-only native-refresh contract.
 *
 * THREE THINGS ARE UNDER TEST, AND THEY ARE DIFFERENT
 * --------------------------------------------------
 * 1. VALIDATION IS PER ENTRY. One effect per reactive *attribute* judged each
 *    write alone, so a combination could become dangerous while no individual
 *    write ever looked wrong:
 *
 *        { "http-equiv": () => equiv(), content: "0;url=javascript:alert(1)" }
 *
 *    `setEquiv("refresh")` re-ran only the `http-equiv` effect; the static
 *    content was never revalidated.
 *
 * 2. PUBLICATION IS ATOMIC. Validating a whole snapshot is not enough if it is
 *    then applied to a CONNECTED element one attribute at a time. Reconciling an
 *    old `x-custom` + dangerous-content element into a new, entirely valid
 *    `refresh` + safe-content one writes `http-equiv="refresh"` while the old
 *    content is still in place — a live dangerous directive that no snapshot
 *    ever approved. Attribute ordering is not a security mechanism, so the
 *    element is built detached and swapped in with one operation.
 *
 * 3. NATIVE REFRESH DIRECTIVES MUST BE STATIC. A browser processes a meta
 *    refresh when the element is INSERTED — it schedules the navigation there
 *    and then. Removing the element afterwards is not a defined cancellation
 *    mechanism, so "reactive refresh" is a promise a framework cannot keep. An
 *    entry with any reactive attribute therefore never publishes a refresh
 *    snapshot, even a perfectly safe one: the question is reversibility, not
 *    safety.
 *
 * The DOM-write recorder below is what makes claim 2 checkable at all. Asserting
 * the final DOM proves nothing about the states passed through on the way there.
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

// ─── DOM-write recorder ─────────────────────────────────────────────────────

interface Observation {
  httpEquiv: string | null;
  content: string | null;
}

type Patchable = Record<string, (...args: never[]) => unknown>;

/**
 * Record the state of every CONNECTED meta element after each DOM mutation.
 *
 * Element state only changes when one of these operations runs, so sampling
 * after each one yields the COMPLETE trace of observable states rather than a
 * sample of it. That is the difference between "the end result is safe" and "no
 * dangerous state ever existed" — and only the second is what atomicity claims.
 */
function recordDomWrites(run: () => void): Observation[] {
  const seen: Observation[] = [];
  const sample = () => {
    for (const m of metas()) {
      seen.push({ httpEquiv: m.getAttribute("http-equiv"), content: m.getAttribute("content") });
    }
  };

  const elementProto = Element.prototype as unknown as Patchable;
  const nodeProto = Node.prototype as unknown as Patchable;
  const patched: [Patchable, string, (...args: never[]) => unknown][] = [
    [elementProto, "setAttribute", elementProto.setAttribute],
    [elementProto, "removeAttribute", elementProto.removeAttribute],
    [elementProto, "replaceWith", elementProto.replaceWith],
    [elementProto, "remove", elementProto.remove],
    [nodeProto, "appendChild", nodeProto.appendChild],
    [nodeProto, "insertBefore", nodeProto.insertBefore],
    [nodeProto, "removeChild", nodeProto.removeChild],
  ];

  for (const [owner, name, original] of patched) {
    owner[name] = function (this: unknown, ...args: never[]) {
      const result = original.apply(this, args);
      sample();
      return result;
    };
  }

  try {
    sample();
    run();
  } finally {
    for (const [owner, name, original] of patched) owner[name] = original;
  }
  return seen;
}

const isRefresh = (o: Observation) => (o.httpEquiv ?? "").trim().toLowerCase() === "refresh";
const isDangerous = (o: Observation) => /javascript:|data:|vbscript:|blob:/i.test(o.content ?? "");

function assertNoForbiddenConnectedState(trace: Observation[]): void {
  const bad = trace.filter((o) => isRefresh(o) && isDangerous(o));
  expect(bad, `a connected element carried a forbidden refresh pair: ${JSON.stringify(bad)}`).toEqual([]);
}

function assertNoConnectedRefresh(trace: Observation[]): void {
  const live = trace.filter(isRefresh);
  expect(live, `a native refresh directive was connected: ${JSON.stringify(live)}`).toEqual([]);
}

beforeEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

// ─── 1. Atomic publication ──────────────────────────────────────────────────

describe("publication is atomic", () => {
  it("never connects the old content beside the new http-equiv", () => {
    // The exact reproduction: ONE state update carries both fields, and the
    // resulting snapshot is entirely valid. The danger is purely in HOW the
    // change is applied.
    const [state, setState] = signal({ equiv: "x-custom", content: DANGEROUS });
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": () => state().equiv, content: () => state().content }] });
      setState({ equiv: "refresh", content: "5;url=/safe" });
    });

    assertNoForbiddenConnectedState(trace);
    if (head) dispose(head);
  });

  it("never connects a partially updated element in either write order", () => {
    // Reversed: the dangerous value arrives in `content` while `http-equiv` is
    // already `refresh`. An implementation that merely ordered its writes to fix
    // the previous case would fail this one.
    const [state, setState] = signal({ equiv: "refresh", content: "5;url=/safe" });
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": () => state().equiv, content: () => state().content }] });
      setState({ equiv: "refresh", content: DANGEROUS });
      setState({ equiv: "x-custom", content: DANGEROUS });
      setState({ equiv: "refresh", content: "6;url=/other" });
    });

    assertNoForbiddenConnectedState(trace);
    if (head) dispose(head);
  });

  it("keeps every attribute write off the document", () => {
    // Stronger than "no forbidden pair appeared": no connected meta element is
    // mutated at all. New elements are built detached and swapped in.
    const [desc, setDesc] = signal("first");
    let head: Comment | undefined;
    const mutations: string[] = [];

    const original = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (this.isConnected && this.tagName === "META") mutations.push(`${name}=${value}`);
      return original.call(this, name, value);
    };
    try {
      head = Head({ meta: [{ name: "description", content: () => desc() }] });
      setDesc("second");
      setDesc("third");
    } finally {
      Element.prototype.setAttribute = original;
    }

    expect(mutations, "a connected meta element was mutated in place").toEqual([]);
    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("content")).toBe("third");
    if (head) dispose(head);
  });

  it("leaves no replaced node behind when disposed after several updates", () => {
    const [desc, setDesc] = signal("a");
    const head = Head({ meta: [{ name: "description", content: () => desc() }] });
    for (const value of ["b", "c", "d", "e"]) setDesc(value);

    expect(metas(), "replaced elements accumulated").toHaveLength(1);
    expect(metas()[0].getAttribute("content")).toBe("e");

    dispose(head);
    expect(metas(), "disposal left a replaced node behind").toHaveLength(0);
  });
});

// ─── 2. The static-only native-refresh contract ─────────────────────────────

describe("a reactive entry never publishes a native refresh", () => {
  it("does not insert one when a reactive http-equiv flips to refresh", () => {
    const [equiv, setEquiv] = signal("x-custom");
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": () => equiv(), content: SAFE }] });
      setEquiv("refresh");
    });

    // Not merely "not dangerous" — not present. The destination is safe; the
    // objection is that a scheduled navigation could not be withdrawn if the
    // state changed back.
    assertNoConnectedRefresh(trace);
    expect(activeRefresh()).toBeUndefined();
    if (head) dispose(head);
  });

  it("does not insert one for a static refresh with reactive content", () => {
    const [content, setContent] = signal(SAFE);
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": "refresh", content: () => content() }] });
      setContent("10;url=/next");
    });

    assertNoConnectedRefresh(trace);
    if (head) dispose(head);
  });

  it("does not insert one when both fields are reactive and initially safe", () => {
    const [equiv] = signal("refresh");
    const [content] = signal(SAFE);
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": () => equiv(), content: () => content() }] });
    });

    assertNoConnectedRefresh(trace);
    if (head) dispose(head);
  });

  it("does not insert one for a reactive delay-only self-refresh", () => {
    // `content="5"` has no destination to police, but it is still a refresh
    // directive the browser schedules the moment the element is inserted.
    const [content] = signal("5");
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": "refresh", content: () => content() }] });
    });

    assertNoConnectedRefresh(trace);
    if (head) dispose(head);
  });

  it("does not insert one when only an unrelated attribute is reactive", () => {
    // The refresh fields are static, but the entry as a whole is republished
    // whenever `id` changes — so it can still be inserted more than once.
    const [id] = signal("a");
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": "refresh", content: SAFE, id: () => id() }] });
    });

    assertNoConnectedRefresh(trace);
    if (head) dispose(head);
  });

  it("publishes the ordinary entry a reactive refresh later becomes", () => {
    const [equiv, setEquiv] = signal("refresh");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: "5;url=/home" }] });

    expect(activeRefresh(), "a reactive refresh was published").toBeUndefined();

    // Now an ordinary non-refresh entry — nothing about it is a navigation, so
    // it publishes normally.
    setEquiv("x-ua-compatible");
    const live = metas().find((m) => m.getAttribute("http-equiv") === "x-ua-compatible");
    expect(live, "an ordinary reactive http-equiv entry was suppressed").toBeDefined();
    expect(live?.getAttribute("content")).toBe("5;url=/home");
    dispose(head);
  });

  it("publishes a reactive description meta that never mentions refresh", () => {
    const [desc, setDesc] = signal("hello");
    const head = Head({ meta: [{ name: "description", content: () => desc() }] });
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("hello");
    setDesc("world");
    expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("world");
    dispose(head);
  });
});

describe("a fully static entry keeps working", () => {
  it("publishes a safe static refresh", () => {
    const head = Head({ meta: [{ "http-equiv": "refresh", content: SAFE }] });
    const live = activeRefresh();
    expect(live, "a static safe refresh was suppressed").toBeDefined();
    expect(live?.getAttribute("content")).toBe(SAFE);
    dispose(head);
  });

  it("publishes a safe static delay-only self-refresh", () => {
    const head = Head({ meta: [{ "http-equiv": "refresh", content: "30" }] });
    expect(activeRefresh()?.getAttribute("content")).toBe("30");
    dispose(head);
  });

  it("never publishes a forbidden static refresh", () => {
    for (const content of [DANGEROUS, DANGEROUS_SPACED, "0;url=data:text/html,x", "0;URL=JAVASCRIPT:alert(1)"]) {
      const head = Head({ meta: [{ "http-equiv": "refresh", content }] });
      expect(activeRefresh(), `${content} became live`).toBeUndefined();
      dispose(head);
    }
  });

  it("never publishes a malformed static refresh", () => {
    for (const content of ['0;url="/safe', "0;url=/a;url=/b", "abc;url=/safe", "0;uri=/safe"]) {
      const head = Head({ meta: [{ "http-equiv": "refresh", content }] });
      expect(activeRefresh(), `${content} became live`).toBeUndefined();
      dispose(head);
    }
  });

  it("keeps a static refresh alongside other static metas", () => {
    const head = Head({
      meta: [
        { "http-equiv": "refresh", content: SAFE },
        { name: "description", content: "A page" },
      ],
    });
    expect(activeRefresh()?.getAttribute("content")).toBe(SAFE);
    expect(document.head.querySelector('meta[name="description"]')).not.toBeNull();
    dispose(head);
  });
});

// ─── 3. Whole-entry validation ──────────────────────────────────────────────

describe("reactive http-equiv with static dangerous content", () => {
  it("cannot become an active dangerous refresh", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS }] });

    expect(activeRefresh()).toBeUndefined();
    setEquiv("refresh");
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

    expect(metas().filter((m) => (m.getAttribute("content") ?? "").includes("javascript:"))).toHaveLength(0);
    dispose(head);
  });
});

describe("transitions", () => {
  const transition = (batched: boolean) => {
    const [equiv, setEquiv] = signal("x-custom");
    const [content, setContent] = signal(DANGEROUS);
    let head: Comment | undefined;

    const trace = recordDomWrites(() => {
      head = Head({ meta: [{ "http-equiv": () => equiv(), content: () => content() }] });
      const step = (fn: () => void) => {
        if (batched) batch(fn);
        else fn();
      };

      // non-refresh + dangerous → refresh + safe → refresh + dangerous
      //   → non-refresh + dangerous → non-refresh + safe
      step(() => {
        setEquiv("refresh");
        setContent(SAFE);
      });
      step(() => setContent(DANGEROUS));
      step(() => setEquiv("x-custom"));
      step(() => setContent(SAFE));
    });

    assertNoForbiddenConnectedState(trace);
    assertNoConnectedRefresh(trace);

    // The final, ordinary state is published.
    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("http-equiv")).toBe("x-custom");
    expect(metas()[0].getAttribute("content")).toBe(SAFE);
    if (head) dispose(head);
  };

  it("stays safe through every transition (unbatched)", () => {
    transition(false);
  });

  it("stays safe through every transition (batched)", () => {
    transition(true);
  });

  it("does not accumulate duplicates across repeated transitions", () => {
    const [content, setContent] = signal("first");
    const head = Head({ meta: [{ name: "description", content: () => content() }] });

    for (let i = 0; i < 5; i++) {
      setContent(`value-${i}`);
      setContent(DANGEROUS);
    }

    // `name="description"` is not a refresh directive, so even the string that
    // would be dangerous inside one is ordinary free text here.
    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("content")).toBe(DANGEROUS);
    dispose(head);
  });

  it("withdraws and restores an entry across forbidden states", () => {
    // `http-equiv` is reactive, so no refresh is ever published — but the
    // non-refresh states are, and the withdrawal/restoration cycle must not
    // duplicate or strand elements.
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS }] });

    expect(metas()).toHaveLength(1);
    setEquiv("refresh"); // forbidden → withdrawn
    expect(metas()).toHaveLength(0);
    setEquiv("x-custom"); // ordinary again → restored
    expect(metas()).toHaveLength(1);
    setEquiv("refresh");
    expect(metas()).toHaveLength(0);
    dispose(head);
    expect(metas()).toHaveLength(0);
  });
});

describe("multiple independently managed entries", () => {
  it("withdraws only the offending entry", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({
      meta: [
        { name: "description", content: "A page" },
        { "http-equiv": () => equiv(), content: DANGEROUS },
        { property: "og:title", content: "Title" },
      ],
    });

    expect(metas()).toHaveLength(3);
    setEquiv("refresh");

    expect(metas()).toHaveLength(2);
    expect(document.head.querySelector('meta[name="description"]')).not.toBeNull();
    expect(document.head.querySelector('meta[property="og:title"]')).not.toBeNull();
    dispose(head);
    expect(metas()).toHaveLength(0);
  });

  it("keeps independent entries independent across replacements", () => {
    const [a, setA] = signal("a1");
    const [b, setB] = signal("b1");
    const head = Head({
      meta: [
        { name: "alpha", content: () => a() },
        { name: "beta", content: () => b() },
      ],
    });

    setA("a2");
    setB("b2");
    setA("a3");

    expect(metas()).toHaveLength(2);
    expect(document.head.querySelector('meta[name="alpha"]')?.getAttribute("content")).toBe("a3");
    expect(document.head.querySelector('meta[name="beta"]')?.getAttribute("content")).toBe("b2");
    dispose(head);
  });
});

describe("attribute reconciliation", () => {
  it("replaces a changed value without appending", () => {
    const [id, setId] = signal("keeper");
    const head = Head({ meta: [{ name: "description", content: "x", id: () => id() }] });
    expect(metas()[0].getAttribute("id")).toBe("keeper");
    setId("other");
    expect(metas()[0].getAttribute("id")).toBe("other");
    expect(metas()).toHaveLength(1);
    dispose(head);
  });

  it("preserves unrelated safe attributes across a withdrawn state", () => {
    const [equiv, setEquiv] = signal("x-custom");
    const head = Head({ meta: [{ "http-equiv": () => equiv(), content: DANGEROUS, id: "keeper" }] });

    expect(metas()[0].getAttribute("id")).toBe("keeper");
    setEquiv("refresh");
    expect(metas()).toHaveLength(0);
    setEquiv("x-custom");
    expect(metas()[0].getAttribute("id"), "an unrelated attribute was lost").toBe("keeper");
    dispose(head);
  });

  it("carries no attribute from a previous snapshot into a new element", () => {
    const [state, setState] = signal<Record<string, string>>({ name: "description", content: "x", id: "gone" });
    const head = Head({
      meta: [{ name: "description", content: () => state().content, id: () => state().id ?? "" }],
    });
    expect(metas()[0].getAttribute("id")).toBe("gone");
    setState({ name: "description", content: "y", id: "" });
    expect(metas()[0].getAttribute("id")).toBe("");
    expect(metas()[0].getAttribute("content")).toBe("y");
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
    expect(metas(), "a duplicate-casing entry was published").toHaveLength(0);
    dispose(head);
  });

  it("refuses an entry with two content spellings", () => {
    const head = Head({
      meta: [{ "HTTP-EQUIV": "refresh", content: SAFE, CONTENT: "0;url=data:text/html,x" }],
    });
    expect(metas()).toHaveLength(0);
    dispose(head);
  });

  it("refuses duplicates of an ordinary attribute even when both values are safe", () => {
    const head = Head({ meta: [{ name: "description", NAME: "description", content: "ok" }] });
    expect(metas(), "the duplicate rule must not depend on the values").toHaveLength(0);
    dispose(head);
  });

  it("refuses duplicates of a name the client would have filtered anyway", () => {
    // The parity case: `onload`/`ONLOAD` are both dropped as event handlers, so
    // filtering first made the client see no duplicate while SSR — checking the
    // raw record — rejected the entry. The check now runs on RAW names.
    const head = Head({ meta: [{ name: "description", content: "ok", onload: "a", ONLOAD: "b" }] });
    expect(metas(), "the client disagreed with SSR about a duplicate handler name").toHaveLength(0);
    dispose(head);
  });

  it("accepts a single spelling in any casing", () => {
    const head = Head({ meta: [{ "HTTP-EQUIV": "refresh", CONTENT: SAFE }] });
    expect(metas()).toHaveLength(1);
    expect(metas()[0].getAttribute("CONTENT")).toBe(SAFE);
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

  it("does not resurrect after disposal following several replacements", () => {
    const [desc, setDesc] = signal("a");
    const head = Head({ meta: [{ name: "description", content: () => desc() }] });
    setDesc("b");
    setDesc("c");
    dispose(head);
    expect(metas()).toHaveLength(0);

    setDesc("d");
    setDesc("e");
    expect(metas(), "a disposed entry was republished").toHaveLength(0);
  });
});
