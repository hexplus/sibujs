/**
 * The shared `<head>` entry pipeline — the thing that makes client, main SSR,
 * and router SSR agree by construction rather than by imitation.
 *
 * WHY THIS LAYER IS TESTED DIRECTLY
 * --------------------------------
 * An earlier version of this pipeline took the name filter and the value
 * sanitizer as PARAMETERS, so each rendering target supplied its own. That is a
 * shared function, not a shared decision, and the three promptly diverged in
 * four separate ways — a case-sensitive URL-attribute set on the client, a
 * scheme blocklist in router SSR where the canonical policy is an allowlist,
 * `srcdoc` kept on the client and dropped by both servers, and refused URLs
 * published as `href=""` on the client and omitted by the servers.
 *
 * Only value RESOLUTION is parameterized now. Everything below is a property of
 * the pipeline itself, so a future caller cannot opt out of it.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalAttrName,
  findDuplicateAttributeName,
  isEmittableHeadAttrName,
  planHeadElementEntry,
  planMetaEntry,
  STATIC_VALUE_RESOLVER,
  sanitizeHeadAttrValue,
} from "../src/utils/headEntry";
import { parseMetaRefreshContent } from "../src/utils/metaRefresh";

/** A resolver with reactive getters, as the client supplies. */
const REACTIVE_RESOLVER = {
  resolveValue: (_name: string, value: string | (() => string)) =>
    typeof value === "function" ? String(value()) : String(value),
  isReactiveValue: (value: string | (() => string)) => typeof value === "function",
};

const attrsOf = (props: Record<string, string>) => {
  const plan = planMetaEntry(props, STATIC_VALUE_RESOLVER);
  return plan.kind === "publish" ? Object.fromEntries(plan.attributes) : null;
};

// ─── canonical names ────────────────────────────────────────────────────────

describe("canonicalAttrName", () => {
  it("lower-cases ASCII letters", () => {
    expect(canonicalAttrName("HREF")).toBe("href");
    expect(canonicalAttrName("Http-Equiv")).toBe("http-equiv");
    expect(canonicalAttrName("sRcDoC")).toBe("srcdoc");
  });

  it("leaves non-ASCII code points alone", () => {
    // `String.prototype.toLowerCase` maps U+212A KELVIN SIGN to ASCII `k`; the
    // HTML parser does not. Folding it would make this function and the browser
    // disagree about what an attribute is called.
    expect(canonicalAttrName("K")).toBe("K");
    expect(canonicalAttrName("İ")).toBe("İ");
  });

  it("is idempotent", () => {
    for (const name of ["HREF", "href", "XLINK:HREF", "data-Foo"]) {
      expect(canonicalAttrName(canonicalAttrName(name))).toBe(canonicalAttrName(name));
    }
  });
});

describe("isEmittableHeadAttrName", () => {
  it("accepts ordinary names in any casing", () => {
    for (const name of ["href", "HREF", "Content", "http-equiv", "data-x", "xlink:href"]) {
      expect(isEmittableHeadAttrName(name), name).toBe(true);
    }
  });

  it("rejects event handlers in any casing", () => {
    for (const name of ["onload", "ONLOAD", "OnError", "onclick"]) {
      expect(isEmittableHeadAttrName(name), name).toBe(false);
    }
  });

  it("rejects srcdoc in any casing", () => {
    for (const name of ["srcdoc", "SRCDOC", "SrcDoc", "srcDOC"]) {
      expect(isEmittableHeadAttrName(name), name).toBe(false);
    }
  });

  it("rejects malformed names", () => {
    for (const name of ["1bad", "a b", 'x"y', "a>b", "", "-x"]) {
      expect(isEmittableHeadAttrName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

// ─── value policy ───────────────────────────────────────────────────────────

describe("sanitizeHeadAttrValue", () => {
  it("returns null for a refused URL rather than an empty string", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:msgbox(1)",
      "blob:https://example.com/id",
      "file:///etc/passwd",
      "about:blank",
      "chrome://settings",
      "custom-scheme:payload",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "  javascript:alert(1)  ",
      "javascript:alert(1)",
    ]) {
      expect(sanitizeHeadAttrValue("href", url), url).toBeNull();
    }
  });

  it("accepts every scheme the canonical allowlist permits", () => {
    for (const url of [
      "https://example.com/a",
      "http://example.com/a",
      "mailto:a@b.com?subject=Hello World",
      "tel:+15551234",
      "ftp://example.com/f",
      "/relative/path",
      "relative/path",
      "#fragment",
      "?query=1",
      "//example.com/protocol-relative",
    ]) {
      expect(sanitizeHeadAttrValue("href", url), url).toBe(url);
    }
  });

  it("applies the URL policy on the canonical name", () => {
    expect(sanitizeHeadAttrValue(canonicalAttrName("HREF"), "javascript:alert(1)")).toBeNull();
    expect(sanitizeHeadAttrValue(canonicalAttrName("SRC"), "javascript:alert(1)")).toBeNull();
    expect(sanitizeHeadAttrValue(canonicalAttrName("XLINK:HREF"), "javascript:alert(1)")).toBeNull();
  });

  it("keeps an empty string for an inert text attribute", () => {
    // `""` means REJECTED only for a policy sink. Everywhere else it is a value.
    expect(sanitizeHeadAttrValue("content", "")).toBe("");
    expect(sanitizeHeadAttrValue("id", "")).toBe("");
    expect(sanitizeHeadAttrValue("name", "anything at all")).toBe("anything at all");
  });

  it("treats an authored empty URL as a rejection, uniformly", () => {
    // One shared answer rather than three: the servers already omitted it, so
    // the client now does too.
    expect(sanitizeHeadAttrValue("href", "")).toBeNull();
    expect(sanitizeHeadAttrValue("src", "   ")).toBeNull();
  });
});

// ─── duplicate names ────────────────────────────────────────────────────────

describe("findDuplicateAttributeName", () => {
  it("reports the canonical name of the first repeat", () => {
    expect(findDuplicateAttributeName(["http-equiv", "content", "HTTP-EQUIV"])).toBe("http-equiv");
    expect(findDuplicateAttributeName(["HREF", "href"])).toBe("href");
  });

  it("returns null when every name is distinct under the canonical fold", () => {
    expect(findDuplicateAttributeName(["NAME", "Content", "id"])).toBeNull();
  });

  it("returns null for an empty entry", () => {
    expect(findDuplicateAttributeName([])).toBeNull();
  });

  it("uses the ASCII fold, matching the parser", () => {
    // The browser only ASCII-lower-cases, so these are two distinct attributes
    // to it — and must be to us as well.
    expect(findDuplicateAttributeName(["K", "k"])).toBeNull();
  });
});

// ─── the pipeline ───────────────────────────────────────────────────────────

describe("planMetaEntry — order of operations", () => {
  it("returns canonical attribute names, whatever the authoring casing", () => {
    // Server HTML and client DOM are then directly comparable rather than
    // merely equivalent.
    expect(attrsOf({ NAME: "description", Content: "A page" })).toEqual({
      name: "description",
      content: "A page",
    });
  });

  it("checks duplicate names BEFORE the name filter", () => {
    // Both handlers would be filtered away, so a duplicate check running after
    // filtering would see a perfectly ordinary description entry.
    expect(attrsOf({ name: "description", content: "ok", onload: "a", ONLOAD: "b" })).toBeNull();
  });

  it("checks duplicate names before resolving any value", () => {
    let reads = 0;
    const plan = planMetaEntry<string | (() => string)>(
      {
        "http-equiv": "refresh",
        "HTTP-EQUIV": "x-custom",
        content: () => {
          reads++;
          return "5;url=/home";
        },
      },
      REACTIVE_RESOLVER,
    );
    expect(plan.kind).toBe("drop");
    expect(reads, "a getter ran for an entry already known to be rejected").toBe(0);
  });

  it("detects duplicates across a URL attribute's casings", () => {
    // The dangerous half would otherwise overwrite the safe half in the DOM.
    expect(attrsOf({ name: "x", href: "/safe", HREF: "javascript:alert(1)" })).toBeNull();
  });

  it("omits a rejected URL and keeps the rest of the entry", () => {
    expect(attrsOf({ name: "x", content: "ok", href: "javascript:alert(1)" })).toEqual({
      name: "x",
      content: "ok",
    });
  });

  it("validates the refresh directive on the effective snapshot", () => {
    expect(attrsOf({ "http-equiv": "refresh", content: "5;url=/home" })).toEqual({
      "http-equiv": "refresh",
      content: "5;url=/home",
    });
    expect(attrsOf({ "HTTP-EQUIV": "refresh", CONTENT: "0;url=javascript:alert(1)" })).toBeNull();
  });

  it("drops an entry whose attributes are all filtered or rejected", () => {
    expect(attrsOf({ onload: "evil()" })).toBeNull();
    expect(attrsOf({ href: "javascript:alert(1)" })).toBeNull();
    expect(attrsOf({ srcdoc: "<script>1</script>" })).toBeNull();
    expect(attrsOf({})).toBeNull();
  });

  it("withholds a refresh directive from a REACTIVE entry, safe or not", () => {
    for (const content of ["5;url=/home", "30"]) {
      const plan = planMetaEntry<string | (() => string)>(
        { "http-equiv": "refresh", content: () => content },
        REACTIVE_RESOLVER,
      );
      // The parse itself still succeeds — this is a PUBLICATION rule. A browser
      // schedules the navigation when the element is inserted, and removing it
      // afterwards is not a defined cancellation, so what cannot be withdrawn is
      // never handed over.
      expect(parseMetaRefreshContent(content).kind).not.toBe("forbidden");
      expect(plan.kind, `${content} was published from a reactive entry`).toBe("drop");
    }
  });

  it("publishes a reactive entry that is not a refresh directive", () => {
    const plan = planMetaEntry<string | (() => string)>(
      { name: "description", content: () => "hello" },
      REACTIVE_RESOLVER,
    );
    if (plan.kind !== "publish") throw new Error("an ordinary reactive entry was withheld");
    expect(plan.attributes.get("content")).toBe("hello");
  });

  it("publishes a STATIC refresh directive unchanged", () => {
    const plan = planMetaEntry({ "http-equiv": "refresh", content: "5;url=/home" }, STATIC_VALUE_RESOLVER);
    if (plan.kind !== "publish") throw new Error("a static safe refresh was withheld");
    expect(plan.refresh.kind).toBe("allowed");
  });
});

describe("planHeadElementEntry — link and script", () => {
  const linkAttrs = (props: Record<string, string>) => {
    const plan = planHeadElementEntry(props, STATIC_VALUE_RESOLVER);
    return plan.kind === "publish" ? Object.fromEntries(plan.attributes) : null;
  };

  it("applies the same name and URL policy as meta entries", () => {
    expect(linkAttrs({ rel: "stylesheet", HREF: "javascript:alert(1)" })).toEqual({ rel: "stylesheet" });
    expect(linkAttrs({ SRC: "data:text/javascript,x" })).toBeNull();
    expect(linkAttrs({ rel: "icon", href: "/favicon.ico" })).toEqual({ rel: "icon", href: "/favicon.ico" });
  });

  it("rejects duplicate names and srcdoc identically", () => {
    expect(linkAttrs({ rel: "a", REL: "b" })).toBeNull();
    expect(linkAttrs({ rel: "x", SRCDOC: "<script>1</script>" })).toEqual({ rel: "x" });
  });

  it("does NOT apply refresh semantics, which have no meaning here", () => {
    // `http-equiv` on a <link> refreshes nothing, so inventing a rule for it
    // would not be a shared decision — it would be a new one.
    expect(linkAttrs({ "http-equiv": "refresh", content: "0;url=/x", rel: "a" })).toEqual({
      "http-equiv": "refresh",
      content: "0;url=/x",
      rel: "a",
    });
  });
});
