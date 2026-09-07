import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div, p, span } from "../src/core/rendering/html";

// ---------------------------------------------------------------------------
// The lone-string class heuristic, measured rather than asserted.
//
// `div("mb-3 aspect-video w-full")` renders Tailwind classes as visible text,
// because a LONE string argument is a text child while `div("mb-3", [child])`
// treats the same string as a class. The shorthand is ergonomic and stays; the
// mistake is made detectable with a dev warning instead.
//
// A heuristic is only honest if its error rate is known on a REALISTIC corpus.
// The first version of this file measured 3.3% false positives and was wrong —
// not arithmetically, but because the corpus was all prose. Real applications
// pass identifiers (`item-0`, `home-content`, `user-42`), versions, paths and
// URLs as ordinary text, and the original rule flagged every one of them. On a
// corpus containing those the true rate was 29.8%, and a list rendering
// `item-0` through `item-999` produced a thousand warnings.
//
// The rule now requires TWO OR MORE tokens with at least two utility-shaped,
// which takes measured false positives to zero: every one of those identifiers
// is a single token, and hyphenated English carries only one utility-shaped
// token per phrase. The cost is single-token class lists — `div("space-y-6")`
// no longer warns — and that trade is deliberate and recorded below.
//
// This is a RATE test with headroom, and the exact misses are listed so a
// change to the heuristic surfaces as a changed list rather than silent drift.
// ---------------------------------------------------------------------------

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/**
 * Does a lone-string `div(s)` trip the class-list warning?
 *
 * Each corpus string is distinct, so the runtime's de-duplication (one warning
 * per tag+string) never fires within a single sweep. Re-checking a string
 * already used in a sweep needs a different tag — see the reported-case test.
 */
function flags(s: string): boolean {
  warn.mockClear();
  div(s);
  return warn.mock.calls.some((c) => String(c[0]).includes("looks like a class list"));
}

// Text a developer legitimately passes as a lone text child.
const TEXT = [
  // prose, labels, button captions
  "Hello world",
  "Submit",
  "Cancel",
  "Save changes",
  "Loading…",
  "No results found",
  "Sign in",
  "Sign out",
  "Create account",
  "Forgot your password?",
  "Try again",
  "Settings",
  "Profile",
  "Dashboard",
  "Notifications",
  "Search",
  "Filter",
  "Sort by",
  "Read more",
  "Show less",
  "Back to top",
  "Next",
  "Previous",
  "Edit",
  "Delete",
  "Duplicate",
  "Archive",
  "Restore",
  "Download",
  "Share",
  "Copy link",
  "Name",
  "Email address",
  "Password",
  "Confirm password",
  "Phone number",
  "Street address",
  "City",
  "Postal code",
  "Country",
  "Date of birth",
  "Are you sure?",
  "This action cannot be undone.",
  "Your changes have been saved.",
  "An unexpected error occurred. Please try again later.",
  "Drag files here or click to upload",
  "Powered by SibuJS",
  "All rights reserved",
  "Select an option",
  "Choose a file",
  "Nothing here yet",
  "Get started",
  "Offline",
  "Reconnecting…",
  "Updated just now",
  "Last updated 3 minutes ago",
  // counts, money, dates, versions
  "3 items selected",
  "12 unread",
  "Page 1 of 20",
  "99+",
  "42",
  "0",
  "1,234 followers",
  "$19.99",
  "€1.500,00",
  "12:30",
  "2026-09-06",
  "3.14159",
  "v4.1.0",
  "100%",
  "50 MB",
  "OK",
  "Yes",
  "No",
  "Done",
  "N/A",
  "—",
  "…",
  // identifiers, keys, paths, URLs — absent from the original corpus, and the
  // reason its 3.3% figure was not the operational rate
  "item-0",
  "item-1",
  "item-999",
  "home-content",
  "main-nav",
  "user-42",
  "row-7",
  "tab-2",
  "step-3",
  "https://example.com",
  "http://localhost:3000",
  "user@example.com",
  "README.md",
  "package.json",
  "src/index.ts",
  "dist/cdn.global.js",
  "GET /api/users",
  "500 Internal Server Error",
  "404 Not Found",
  // hyphenated English, both as phrases and as lone labels
  "e-mail address",
  "state-of-the-art design",
  "up-to-date now",
  "well-known issues",
  "opt-in only",
  "read-only field",
  "built-in support",
  "end-to-end tests",
  "real-time updates",
  "drag-and-drop here",
  "end-to-end",
  "state-of-the-art",
  "up-to-date",
  "drag-and-drop",
  "out-of-stock",
  "one-to-one",
  "read-only",
  "well-known",
  "built-in",
  "real-time",
  "opt-in",
  "sign-in",
  "follow-up",
  "check-in",
  // non-English
  "Iniciar sesión",
  "Cerrar sesión",
  "Guardar cambios",
  "No hay resultados",
  "こんにちは",
  "登录",
  "Anmelden",
  "S'inscrire",
  "Zurück",
  "Weiter",
];

// Strings that really are a className, passed by mistake.
const CLASSES = [
  "mb-3 aspect-video w-full",
  "space-y-6",
  "h-6 w-48",
  "flex items-center gap-2",
  "text-sm text-muted-foreground",
  "rounded-lg border bg-card p-6 shadow-sm",
  "grid grid-cols-3 gap-4",
  "absolute inset-0 z-50",
  "md:flex lg:hidden",
  "w-1/2",
  "mt-4",
  "px-4 py-2",
  "font-semibold tracking-tight",
  "hover:bg-accent focus:outline-none",
  "min-h-screen",
  "max-w-2xl mx-auto",
  "btn btn-primary",
  "card card-body",
  "col-md-6",
  "d-flex justify-content-between",
  "sr-only",
  "animate-pulse",
  "overflow-x-auto",
  "border-t-2",
  "opacity-50",
  "dark:bg-slate-900",
  "text-2xl",
  "gap-x-8",
  "truncate",
  "sticky top-0",
  "list-none",
  "cursor-pointer select-none",
  "transition-colors duration-200",
  "bg-red-500 text-white",
  "ring-2 ring-offset-2",
  "aspect-square object-cover",
  "container mx-auto px-4",
  "h-full w-full",
  "leading-6",
  "-mt-px",
  "z-10",
];

// Every miss is a single token, or a pair carrying only ONE utility-shaped
// token ("btn btn-primary", "sticky top-0"). Accepted in exchange for a zero
// false-positive rate; a warning that cries wolf protects nobody.
const KNOWN_FALSE_NEGATIVES = [
  "space-y-6",
  "w-1/2",
  "mt-4",
  "min-h-screen",
  "btn btn-primary",
  "card card-body",
  "col-md-6",
  "sr-only",
  "animate-pulse",
  "overflow-x-auto",
  "border-t-2",
  "opacity-50",
  "dark:bg-slate-900",
  "text-2xl",
  "gap-x-8",
  "truncate",
  "sticky top-0",
  "list-none",
  "leading-6",
  "-mt-px",
  "z-10",
];

describe("lone-string class heuristic: measured error rate", () => {
  it("flags no prose, identifier, path, URL or version in the corpus", () => {
    const wrong = TEXT.filter(flags);
    expect(wrong).toEqual([]);
  });

  it("has a false-negative rate at or below 55% on real class lists", () => {
    const missed = CLASSES.filter((s) => !flags(s));
    expect(missed).toEqual(KNOWN_FALSE_NEGATIVES);
    expect(missed.length / CLASSES.length).toBeLessThanOrEqual(0.55);
  });

  it("catches the exact string from the original report", () => {
    // A different tag than the corpus sweep used, so the tag+string
    // de-duplication key is fresh and this asserts against a real warning.
    warn.mockClear();
    span("mb-3 aspect-video w-full");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("looks like a class list");
  });

  it("does not flood: one warning per repeated mistake, not one per element", () => {
    // The failure this replaced: a list of 1,000 rows produced 1,000 warnings.
    warn.mockClear();
    for (let i = 0; i < 500; i++) p("grid grid-cols-3 gap-4");
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("looks like a class list"));
    expect(hits).toHaveLength(1);
  });

  it("still reports a DIFFERENT mistaken class string", () => {
    warn.mockClear();
    p("flex items-center gap-2");
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("looks like a class list"));
    expect(hits).toHaveLength(1);
  });

  it("never changes behaviour — a flagged string is still rendered as text", () => {
    const el = div("px-4 py-2");
    expect(el.textContent).toBe("px-4 py-2");
    expect(el.getAttribute("class")).toBeNull();
  });

  it("treats the same string as a class when children follow", () => {
    const el = div("mb-3 aspect-video w-full", [div("child")]);
    expect(el.getAttribute("class")).toBe("mb-3 aspect-video w-full");
    expect(el.textContent).toBe("child");
  });
});
