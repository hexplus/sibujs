import { afterEach, describe, expect, it } from "vitest";
import { datePicker } from "../src/widgets/datePicker";

function d(year: number, month: number, day: number): Date {
  return new Date(year, month, day);
}

function setup(dp: ReturnType<typeof datePicker>) {
  const grid = document.createElement("div");
  const cells = new Map<string, HTMLElement>();
  const key = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const cell = (date: Date) => {
    const k = key(date);
    let el = cells.get(k);
    if (!el) {
      el = document.createElement("div");
      cells.set(k, el);
    }
    return el;
  };
  document.body.appendChild(grid);
  const dispose = dp.bind({ grid, cell });
  return { grid, cell, cells, key, dispose };
}

describe("datePicker coverage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("initializes selected and view date from options", () => {
    const init = d(2026, 4, 15);
    const dp = datePicker({ initialDate: init });
    expect(dp.selectedDate()).toEqual(init);
    expect(dp.viewDate().getMonth()).toBe(4);
  });

  it("defaults viewDate to today when no initialDate", () => {
    const dp = datePicker();
    expect(dp.selectedDate()).toBeNull();
    expect(dp.viewDate()).toBeInstanceOf(Date);
  });

  it("select sets date and respects min/max", () => {
    const dp = datePicker({ minDate: d(2026, 0, 10), maxDate: d(2026, 0, 20) });
    dp.select(d(2026, 0, 15));
    expect(dp.selectedDate()).toEqual(d(2026, 0, 15));
    dp.select(d(2026, 0, 5)); // before min -> rejected
    expect(dp.selectedDate()).toEqual(d(2026, 0, 15));
    dp.select(d(2026, 0, 25)); // after max -> rejected
    expect(dp.selectedDate()).toEqual(d(2026, 0, 15));
  });

  it("isDateDisabled honors min and max", () => {
    const dp = datePicker({ minDate: d(2026, 0, 10), maxDate: d(2026, 0, 20) });
    expect(dp.isDateDisabled(d(2026, 0, 5))).toBe(true);
    expect(dp.isDateDisabled(d(2026, 0, 25))).toBe(true);
    expect(dp.isDateDisabled(d(2026, 0, 15))).toBe(false);
  });

  it("nextMonth/prevMonth/nextYear/prevYear shift view without overflow", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 31) });
    dp.nextMonth();
    expect(dp.viewDate().getMonth()).toBe(1);
    expect(dp.viewDate().getDate()).toBe(1);
    dp.prevMonth();
    expect(dp.viewDate().getMonth()).toBe(0);
    dp.nextYear();
    expect(dp.viewDate().getFullYear()).toBe(2027);
    dp.prevYear();
    expect(dp.viewDate().getFullYear()).toBe(2026);
  });

  it("setViewDate updates view", () => {
    const dp = datePicker();
    dp.setViewDate(d(2030, 6, 1));
    expect(dp.viewDate().getFullYear()).toBe(2030);
    expect(dp.viewDate().getMonth()).toBe(6);
  });

  it("daysInMonth fills full weeks with leading/trailing days", () => {
    const dp = datePicker({ initialDate: d(2026, 4, 15) }); // May 2026 (May 1 is Friday)
    const days = dp.daysInMonth();
    expect(days.length % 7).toBe(0);
    const current = days.filter((x) => x.isCurrentMonth);
    expect(current.length).toBe(31); // May has 31 days
    // Leading days from April and trailing days from June present.
    expect(days[0].isCurrentMonth).toBe(false);
    expect(days[days.length - 1].isCurrentMonth).toBe(false);
  });

  it("daysInMonth marks selected and disabled days", () => {
    const dp = datePicker({
      initialDate: d(2026, 0, 15),
      minDate: d(2026, 0, 10),
    });
    const days = dp.daysInMonth();
    const sel = days.find((x) => x.isSelected);
    expect(sel?.date.getDate()).toBe(15);
    const disabled = days.find((x) => x.isCurrentMonth && x.date.getDate() === 5);
    expect(disabled?.isDisabled).toBe(true);
  });

  it("isSelected reactive getter", () => {
    const dp = datePicker();
    expect(dp.isSelected(d(2026, 0, 1))).toBe(false);
    dp.select(d(2026, 0, 1));
    expect(dp.isSelected(d(2026, 0, 1))).toBe(true);
  });

  it("bind sets grid role, tabindex, and cell aria", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15), minDate: d(2026, 0, 10) });
    const { grid, cells, key } = setup(dp);
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.tabIndex).toBe(0);
    const selectedCell = cells.get(key(d(2026, 0, 15)))!;
    expect(selectedCell.getAttribute("role")).toBe("gridcell");
    expect(selectedCell.getAttribute("aria-selected")).toBe("true");
    expect(selectedCell.tabIndex).toBe(0); // view date roving tabindex
    const disabledCell = cells.get(key(d(2026, 0, 5)))!;
    expect(disabledCell.getAttribute("aria-disabled")).toBe("true");
  });

  it("arrow keys move view date by day and week", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15) });
    const { grid } = setup(dp);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(dp.viewDate().getDate()).toBe(16);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(dp.viewDate().getDate()).toBe(15);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(dp.viewDate().getDate()).toBe(22);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(dp.viewDate().getDate()).toBe(15);
  });

  it("Home moves to start of week, End to end of week", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15) }); // Jan 15 2026 is Thursday (dow 4)
    const { grid } = setup(dp);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(dp.viewDate().getDay()).toBe(0);
    expect(dp.viewDate().getDate()).toBe(11); // Sunday
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(dp.viewDate().getDay()).toBe(6);
    expect(dp.viewDate().getDate()).toBe(17); // Saturday
  });

  it("PageUp/PageDown change month, Shift+Page change year", () => {
    const dp = datePicker({ initialDate: d(2026, 5, 15) });
    const { grid } = setup(dp);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    expect(dp.viewDate().getMonth()).toBe(6);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    expect(dp.viewDate().getMonth()).toBe(5);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", shiftKey: true }));
    expect(dp.viewDate().getFullYear()).toBe(2027);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", shiftKey: true }));
    expect(dp.viewDate().getFullYear()).toBe(2026);
  });

  it("Enter and Space select the view date", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15) });
    const { grid } = setup(dp);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(dp.selectedDate()).toEqual(d(2026, 0, 15));

    const dp2 = datePicker({ initialDate: d(2026, 0, 20) });
    const env2 = setup(dp2);
    env2.grid.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(dp2.selectedDate()).toEqual(d(2026, 0, 20));
  });

  it("unhandled key is ignored", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15) });
    const { grid } = setup(dp);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(dp.viewDate().getDate()).toBe(15);
  });

  it("bind twice returns same teardown and teardown removes listener", () => {
    const dp = datePicker({ initialDate: d(2026, 0, 15) });
    const grid = document.createElement("div");
    const cell = () => document.createElement("div");
    const t1 = dp.bind({ grid, cell });
    const t2 = dp.bind({ grid, cell });
    expect(t1).toBe(t2);
    t1();
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(dp.viewDate().getDate()).toBe(15);
  });
});
