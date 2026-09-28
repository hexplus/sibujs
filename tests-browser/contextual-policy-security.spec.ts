/**
 * Real-engine proof for the contextual element policy.
 *
 * jsdom neither navigates on a meta refresh nor executes a created `<script>`,
 * so the unit suite can only prove what the DOM LOOKS like. This spec proves
 * what the ENGINE DOES with it, in Chromium, Firefox and WebKit:
 *
 *   - the generic DOM APIs (`meta()`, `html```, reactive getters) never connect
 *     a refresh directive the shared policy refuses, and a reactive one never
 *     navigates — proven by the complete trace of connected states plus a
 *     counted, intercepted protected destination;
 *   - a runtime value in `html\`<script src=${…}>\`` is never even requested,
 *     while the developer-authored static control IS requested and runs — so
 *     "nothing happened" is a statement about the policy, not the harness;
 *   - every URL the framework keeps resolves, in the engine's own URL parser,
 *     to an allowed scheme, including the ambiguous spellings.
 *
 * Every destination is same-origin. No external host is contacted.
 */

import { expect, type Page, test } from "@playwright/test";

const PAGE = "/examples/contextual-policy-security-browser.html";
const PROTECTED = "**/examples/should-never-load.html*";

interface Api {
  reset(): boolean;
  connectedRefreshStates(): Array<{ httpEquiv: string | null; content: string | null }>;
  genericReactiveRefresh(): number;
  genericStaticForbidden(): number;
  templateContentBeforeEquiv(): number;
  staticSafeRefresh(tag: string): number;
  arrivedAt(): string | null;
  xss(): boolean;
  runtimeScriptSource(): boolean;
  staticScriptSource(): boolean;
  probeRuns(): number;
  svgScriptRefused(): boolean;
  runtimeStylesheets(): number;
  staticStylesheet(): boolean;
  probeStyleApplied(): string;
  urlCases(inputs: string[]): Array<{ input: string; kept: string | null; scheme: string | null }>;
}

const api = <K extends keyof Api>(page: Page, key: K, ...args: Parameters<Api[K]>) =>
  page.evaluate(
    ([k, a]) => {
      const t = (window as unknown as { __t: Record<string, (...x: unknown[]) => unknown> }).__t;
      return t[k as string](...(a as unknown[]));
    },
    [key, args] as const,
  ) as Promise<ReturnType<Api[K]>>;

async function protect(page: Page, pattern: string): Promise<() => number> {
  let requests = 0;
  await page.route(pattern, (route) => {
    requests++;
    return route.abort();
  });
  return () => requests;
}

/** A real, static, same-origin refresh — the per-test proof that the engine acts on refreshes. */
async function proveEngineHonoursRefresh(page: Page, tag: string): Promise<void> {
  expect(await api(page, "staticSafeRefresh", tag), "the static control refresh was suppressed").toBe(1);
  await page.waitForURL(new RegExp(`arrived=${tag}`), { timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  expect(await api(page, "arrivedAt")).toBe(tag);
}

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await api(page, "reset");
});

test("control: a static safe meta() refresh IS honoured", async ({ page }) => {
  await proveEngineHonoursRefresh(page, "control");
});

test("meta() with a reactive content getter never navigates, even to a safe destination", async ({ page }) => {
  const requests = await protect(page, PROTECTED);
  expect(await api(page, "genericReactiveRefresh")).toBe(0);
  expect(await api(page, "connectedRefreshStates")).toEqual([]);
  await proveEngineHonoursRefresh(page, "reactive");
  expect(requests(), "a reactive generic meta navigated").toBe(0);
});

test("meta() never connects a forbidden refresh directive", async ({ page }) => {
  expect(await api(page, "genericStaticForbidden")).toBe(0);
  expect(await api(page, "connectedRefreshStates")).toEqual([]);
  expect(await api(page, "xss")).toBe(false);
});

test("html`` refuses runtime content even when the static http-equiv is written second", async ({ page }) => {
  expect(await api(page, "templateContentBeforeEquiv")).toBe(0);
  expect(await api(page, "connectedRefreshStates")).toEqual([]);
  expect(await api(page, "xss")).toBe(false);
});

test("a runtime <script src> is never requested; the static control is", async ({ page }) => {
  const runtimeRequests = await protect(page, "**/contextual-policy-probe.js?runtime*");
  expect(await api(page, "runtimeScriptSource"), "the runtime src was committed").toBe(false);

  await api(page, "staticScriptSource");
  await page.waitForFunction(() => ((window as unknown as { __probeRuns?: number }).__probeRuns ?? 0) >= 1);
  expect(await api(page, "probeRuns")).toBe(1);
  expect(runtimeRequests(), "the runtime-chosen script was requested").toBe(0);
});

test("a runtime-chosen stylesheet is never requested; the static control is applied", async ({ page }) => {
  // The preload of the reactive-flip case may legitimately fetch the file (a
  // preload never applies it); what must never happen is it becoming a
  // stylesheet. So requests are counted per variant, and the flip is judged by
  // the DOM plus the applied style.
  const plainRequests = await protect(page, "**/contextual-policy-probe.css?runtime");
  expect(await api(page, "runtimeStylesheets"), "a runtime href was left on a stylesheet link").toBe(0);
  expect(await api(page, "probeStyleApplied"), "runtime CSS was applied").toBe("");

  await api(page, "staticStylesheet");
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--contextual-probe").trim() === "applied",
  );
  expect(plainRequests(), "a runtime stylesheet URL was requested").toBe(0);
});

test("svgElement refuses an SVG <script>", async ({ page }) => {
  const requests = await protect(page, "**/contextual-policy-probe.js?svg*");
  expect(await api(page, "svgScriptRefused")).toBe(true);
  expect(requests()).toBe(0);
});

test("every URL the framework keeps resolves to an allowed scheme in this engine", async ({ page }) => {
  const inputs = [
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "java\u0000script:alert(1)",
    "\u0001javascript:alert(1)",
    "\u0085javascript:alert(1)",
    "\u00a0javascript:alert(1)",
    "\ufeffjavascript:alert(1)",
    "&#106;avascript:alert(1)",
    "jav&#x61;script:alert(1)",
    "%6a%61%76%61%73%63%72%69%70%74:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:http://localhost/x",
    "//example.com/x",
    "\\\\example.com\\x",
    "/\\example.com/x",
    "https://example.com/ok",
    "mailto:a@b.example",
  ];
  const allowed = new Set(["http:", "https:", "mailto:", "tel:", "ftp:"]);
  for (const row of await api(page, "urlCases", inputs)) {
    if (row.kept === null) continue;
    expect(row.scheme === ":" || allowed.has(row.scheme ?? ""), `${JSON.stringify(row)}`).toBe(true);
  }
});
