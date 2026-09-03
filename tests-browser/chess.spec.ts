import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Real-browser coverage for the chess reference island.
//
// These are the behaviours jsdom cannot validate honestly: real focus movement,
// `:focus-visible`, native button activation from the keyboard, live-region
// semantics, and whether a reactive update disturbs the focused element.
//
// Runs on Chromium, Firefox and WebKit (see playwright.config.ts).
// ---------------------------------------------------------------------------

const PAGE = "/examples/chess/";

const board = (n: 1 | 2) => `[data-board="${n}"]`;
const square = (n: 1 | 2, sq: string) => `${board(n)} [data-square="${sq}"]`;

/** The shortest legal line that ends in a promotion (verified against chess.js). */
const TO_PROMOTION: Array<[string, string]> = [
  ["h2", "h4"],
  ["g7", "g5"],
  ["h4", "g5"],
  ["h7", "h6"],
  ["g5", "h6"],
  ["a7", "a6"],
  ["h6", "h7"],
  ["b7", "b6"],
];

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator(`${board(1)}[data-sibu-enhanced="true"]`)).toHaveCount(1);
});

/**
 * Play the fixture moves that get a test to an interesting position.
 *
 * These dispatch real `click` events through the real listeners — the only
 * thing skipped is pointer emulation, which is not what these tests are about
 * and costs a hit-test per square. The behaviour under test always uses real
 * `page.click` / `page.keyboard`.
 */
async function playFixture(page: import("@playwright/test").Page, moves: Array<[string, string]>) {
  await page.evaluate((list) => {
    const b = document.querySelector('[data-board="1"]') as HTMLElement;
    for (const [from, to] of list) {
      b.querySelector<HTMLButtonElement>(`[data-square="${from}"]`)?.click();
      b.querySelector<HTMLButtonElement>(`[data-square="${to}"]`)?.click();
    }
  }, moves);
}

test("a mouse move updates only the squares involved, and keeps every node", async ({ page }) => {
  const ids = await page.$$eval(`${board(1)} [data-square]`, (els) => els.map((el, i) => ((el as HTMLElement).dataset.probe = String(i))));
  expect(ids).toHaveLength(64);

  await page.click(square(1, "e2"));
  await expect(page.locator(square(1, "e2"))).toHaveAttribute("data-marks", "selected");
  await expect(page.locator(square(1, "e4"))).toHaveAttribute("data-marks", "legal");

  await page.click(square(1, "e4"));
  await expect(page.locator(`${square(1, "e4")} .piece`)).toHaveText("♙");
  await expect(page.locator(`${square(1, "e2")} .piece`)).toHaveText("");
  await expect(page.locator(`${board(1)} [data-ref="status"]`)).toContainText("Black to move");

  // Every square is the SAME element it was before the move — the marker
  // written into the DOM above survived, so nothing was rebuilt.
  const probes = await page.$$eval(`${board(1)} [data-square]`, (els) =>
    els.map((el) => (el as HTMLElement).dataset.probe),
  );
  expect(probes).toEqual(Array.from({ length: 64 }, (_, i) => String(i)));
});

test("keyboard: arrows navigate the grid and Enter/Space play the move", async ({ page }) => {
  await page.locator(square(1, "e2")).focus();
  await expect(page.locator(square(1, "e2"))).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(page.locator(square(1, "e3"))).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(square(1, "d3"))).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.locator(square(1, "a3"))).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator(square(1, "h3"))).toBeFocused();

  // Enter on a real <button> is a click — no extra handler, no double fire.
  await page.locator(square(1, "d2")).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(square(1, "d2"))).toHaveAttribute("data-marks", "selected");
  await page.locator(square(1, "d4")).focus();
  await page.keyboard.press(" ");
  await expect(page.locator(`${square(1, "d4")} .piece`)).toHaveText("♙");
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveText(["1. d4"]);
});

test("exactly one move is recorded per activation (no duplicate handlers)", async ({ page }) => {
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));
  await page.click(square(1, "e7"));
  await page.click(square(1, "e5"));
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveText(["1. e4 e5"]);
});

test("focus is preserved across a reactive update", async ({ page }) => {
  await page.locator(square(1, "g1")).focus();
  await expect(page.locator(square(1, "g1"))).toBeFocused();

  // Trigger the update WITHOUT a real pointer press, so the only thing that
  // could move focus is the framework. Flipping re-runs a binding on all 64
  // squares; every one of them writes into a node that already exists, so the
  // focused element is never detached and focus never moves.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-board="1"] [data-ref="flip"]')?.click();
  });
  await expect(page.locator(`${board(1)} [data-ref="board"]`)).toHaveClass(/flipped/);
  await expect(page.locator(square(1, "g1"))).toBeFocused();

  // The same holds for a whole-engine invalidation: play a move programmatically
  // and the focused square keeps focus.
  await page.evaluate(() => {
    const b = document.querySelector('[data-board="1"]') as HTMLElement;
    b.querySelector<HTMLButtonElement>('[data-square="e2"]')?.click();
    b.querySelector<HTMLButtonElement>('[data-square="e4"]')?.click();
  });
  await expect(page.locator(`${square(1, "e4")} .piece`)).toHaveText("♙");
  await expect(page.locator(square(1, "g1"))).toBeFocused();
});

test("the status region is a live region with the right semantics", async ({ page }) => {
  const status = page.locator(`${board(1)} [data-ref="status"]`);
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));
  await expect(status).toContainText("White plays e4");
});

test("promotion: the dialog takes focus, traps Tab, and names itself", async ({ page }) => {
  await playFixture(page, TO_PROMOTION);

  await page.locator(square(1, "h7")).focus();
  await page.keyboard.press("Enter");
  await page.locator(square(1, "g8")).focus();
  await page.keyboard.press("Enter");

  const dialog = page.locator(`${board(1)} [data-ref="promotion"]`);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAccessibleName("Promote your pawn");

  // Focus moved INTO the dialog.
  await expect(dialog.getByRole("button", { name: "Queen" })).toBeFocused();

  // Tab cycles inside it: forward from the last control wraps to the first.
  const controls = dialog.locator("button");
  const count = await controls.count();
  for (let i = 0; i < count - 1; i++) await page.keyboard.press("Tab");
  await expect(controls.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
});

test("promotion: Escape cancels, commits nothing and restores focus to the board", async ({ page }) => {
  await playFixture(page, TO_PROMOTION);
  await page.click(square(1, "h7"));
  await page.click(square(1, "g8"));

  const dialog = page.locator(`${board(1)} [data-ref="promotion"]`);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(square(1, "g8"))).toBeFocused();
  // Nothing was played: the pawn is still on h7 and the move list is unchanged.
  await expect(page.locator(`${square(1, "h7")} .piece`)).toHaveText("♙");
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveCount(4);
});

test("promotion: choosing a piece commits exactly one move and returns focus", async ({ page }) => {
  await playFixture(page, TO_PROMOTION);
  await page.click(square(1, "h7"));
  await page.click(square(1, "g8"));

  const dialog = page.locator(`${board(1)} [data-ref="promotion"]`);
  await dialog.getByRole("button", { name: "Knight" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(square(1, "g8"))).toBeFocused();
  await expect(page.locator(`${square(1, "g8")} .piece`)).toHaveText("♘");
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`).last()).toHaveText("5. hxg8=N");
});

test("dynamic history rows are inserted as the game grows", async ({ page }) => {
  await expect(page.locator(`${board(1)} [data-ref="moves-empty"]`)).toBeVisible();
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveCount(1);
  await page.click(square(1, "e7"));
  await page.click(square(1, "e5"));
  await page.click(square(1, "g1"));
  await page.click(square(1, "f3"));
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveCount(2);
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`).last()).toContainText("Nf3");
});

test("two boards on one page are completely independent", async ({ page }) => {
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));

  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveCount(1);
  await expect(page.locator(`${board(2)} [data-ref="moves-empty"]`)).toBeVisible();
  await expect(page.locator(`${board(2)} [data-ref="status"]`)).toContainText("White to move");

  await page.click(square(2, "d2"));
  await page.click(square(2, "d4"));
  await expect(page.locator(`${board(2)} [data-ref="moves"] li`)).toHaveText(["1. d4"]);
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveText(["1. e4"]);
});

test("a broken island beside them changes nothing", async ({ page }) => {
  await expect(page.locator('[data-sibu-island="broken"]')).not.toHaveAttribute("data-sibu-enhanced", "true");
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));
  await expect(page.locator(`${square(1, "e4")} .piece`)).toHaveText("♙");
});

test("disposing the island stops it and leaves the server markup in place", async ({ page }) => {
  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));

  await page.evaluate(() => (window as unknown as { chessExample: { dispose(): void } }).chessExample.dispose());

  await expect(page.locator(board(1))).not.toHaveAttribute("data-sibu-enhanced", "true");
  await expect(page.locator(`${board(1)} [data-square]`)).toHaveCount(64);
  await expect(page.locator(`${board(1)} [data-ref="moves"]`)).toHaveCount(0);

  // Clicking a square now does nothing at all — the listeners are gone.
  const before = await page.locator(`${square(1, "d2")}`).getAttribute("data-marks");
  await page.click(square(1, "d2"));
  await expect(page.locator(square(1, "d2"))).toHaveAttribute("data-marks", before ?? "");
});

test("reinitialising after a host navigation gives one clean generation", async ({ page }) => {
  await page.evaluate(() => {
    const api = (window as unknown as { chessExample: { dispose(): void; remount(): void } }).chessExample;
    api.dispose();
    api.remount();
  });

  await expect(page.locator(`${board(1)}[data-sibu-enhanced="true"]`)).toHaveCount(1);
  // Exactly one mounted history region — not one per mount call.
  await expect(page.locator(`${board(1)} [data-ref="history"] .history`)).toHaveCount(1);

  await page.click(square(1, "e2"));
  await page.click(square(1, "e4"));
  await expect(page.locator(`${board(1)} [data-ref="moves"] li`)).toHaveText(["1. e4"]);
});
