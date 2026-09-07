import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";

// ---------------------------------------------------------------------------
// The lone-string class heuristic, measured rather than asserted.
//
// `div("mb-3 aspect-video w-full")` renders Tailwind classes as visible text,
// because a LONE string argument is a text child while `div("mb-3", [child])`
// treats the same string as a class. The shorthand is ergonomic and stays; the
// mistake is made detectable with a dev warning instead.
//
// A heuristic is only honest if its error rate is known, so this file pins both
// directions on a representative corpus. It is a RATE test: the thresholds have
// headroom, and the specific known-wrong strings are listed so a future change
// to the heuristic shows up as a changed list rather than a silent drift.
//
// Measured at the time of writing: 3.3% false positives (4/123 prose strings),
// 2.4% false negatives (1/41 class lists).
// ---------------------------------------------------------------------------

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** Does a lone-string `div(s)` trip the class-list warning? */
function flags(s: string): boolean {
  warn.mockClear();
  div(s);
  return warn.mock.calls.some((c) => String(c[0]).includes("looks like a class list"));
}

// Strings a developer legitimately passes as a lone text child: labels, button
// captions, counts, units, dates, error copy, and non-English content.
const TEXT = [
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
  "Are you sure?",
  "This action cannot be undone.",
  "Your changes have been saved.",
  "An unexpected error occurred. Please try again later.",
  "Drag files here or click to upload",
  "Powered by SibuJS",
  "All rights reserved",
  "Read more",
  "Show less",
  "Learn more →",
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
  "user@example.com",
  "https://example.com",
  "README.md",
  "package.json",
  "src/index.ts",
  "GET /api/users",
  "500 Internal Server Error",
  "404 Not Found",
  "on",
  "off",
  "true",
  "false",
  "null",
  "N/A",
  "—",
  "…",
  "OK",
  "Yes",
  "No",
  "Done",
  "Close",
  "Open",
  "Apply",
  "Reset",
  "Clear",
  "Continue",
  "Item",
  "Items",
  "User",
  "Users",
  "Order",
  "Orders",
  "Invoice",
  "Report",
  "TODO",
  "WIP",
  "Beta",
  "New",
  "Pro",
  "Free",
  "Trial expired",
  "Last updated 3 minutes ago",
  "Updated just now",
  "Offline",
  "Reconnecting…",
  "Select an option",
  "Choose a file",
  "Nothing here yet",
  "Get started",
];

// Strings that are really a className, passed by mistake.
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

// The heuristic keys off "every token is class-shaped AND at least one carries a
// hyphen/colon/slash/digit". These four prose strings satisfy that by accident.
const KNOWN_FALSE_POSITIVES = ["v4.1.0", "https://example.com", "src/index.ts", "N/A"];
// A single-word utility class has no hyphen, colon, slash or digit, so it is
// indistinguishable from the word "truncate" used as a label.
const KNOWN_FALSE_NEGATIVES = ["truncate"];

describe("lone-string class heuristic: measured error rate", () => {
  it("has a false-positive rate at or below 5% on prose", () => {
    const wrong = TEXT.filter(flags);
    expect(wrong).toEqual(KNOWN_FALSE_POSITIVES);
    expect(wrong.length / TEXT.length).toBeLessThanOrEqual(0.05);
  });

  it("has a false-negative rate at or below 10% on real class lists", () => {
    const missed = CLASSES.filter((s) => !flags(s));
    expect(missed).toEqual(KNOWN_FALSE_NEGATIVES);
    expect(missed.length / CLASSES.length).toBeLessThanOrEqual(0.1);
  });

  it("catches the exact string from the original report", () => {
    expect(flags("mb-3 aspect-video w-full")).toBe(true);
  });

  it("never changes behaviour — a flagged string is still rendered as text", () => {
    const el = div("mb-3 aspect-video w-full");
    expect(el.textContent).toBe("mb-3 aspect-video w-full");
    expect(el.getAttribute("class")).toBeNull();
  });

  it("treats the same string as a class when children follow", () => {
    const el = div("mb-3 aspect-video w-full", [div("child")]);
    expect(el.getAttribute("class")).toBe("mb-3 aspect-video w-full");
    expect(el.textContent).toBe("child");
  });
});
