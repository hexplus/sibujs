import { describe, expect, it } from "vitest";
import { datePicker } from "../src/widgets/datePicker";

describe("datePicker", () => {
  it("starts with no selected date and today as view date", () => {
    const dp = datePicker();
    expect(dp.selectedDate()).toBeNull();
    // viewDate should be roughly today
    const now = new Date();
    expect(dp.viewDate().getMonth()).toBe(now.getMonth());
    expect(dp.viewDate().getFullYear()).toBe(now.getFullYear());
  });

  it("uses initialDate for both selectedDate and viewDate", () => {
    const initial = new Date(2024, 5, 15); // June 15, 2024
    const dp = datePicker({ initialDate: initial });
    expect(dp.selectedDate()).toEqual(initial);
    expect(dp.viewDate().getMonth()).toBe(5);
    expect(dp.viewDate().getFullYear()).toBe(2024);
  });

  it("selects a date", () => {
    const dp = datePicker();
    const date = new Date(2024, 0, 10); // Jan 10, 2024
    dp.select(date);
    expect(dp.selectedDate()).toEqual(date);
  });

  it("navigates months and years", () => {
    const dp = datePicker({
      initialDate: new Date(2024, 0, 1), // Jan 2024
    });

    dp.nextMonth();
    expect(dp.viewDate().getMonth()).toBe(1); // Feb

    dp.prevMonth();
    expect(dp.viewDate().getMonth()).toBe(0); // Jan

    dp.nextYear();
    expect(dp.viewDate().getFullYear()).toBe(2025);

    dp.prevYear();
    expect(dp.viewDate().getFullYear()).toBe(2024);
  });

  it("generates days grid with correct current month flags", () => {
    const dp = datePicker({
      initialDate: new Date(2024, 0, 15), // Jan 15, 2024
    });

    const days = dp.daysInMonth();

    // Total should be a multiple of 7
    expect(days.length % 7).toBe(0);

    // All current month days should have isCurrentMonth true
    const currentMonthDays = days.filter((d) => d.isCurrentMonth);
    expect(currentMonthDays.length).toBe(31); // Jan has 31 days

    // The selected date should be marked
    const selectedDay = days.find((d) => d.isCurrentMonth && d.date.getDate() === 15);
    expect(selectedDay?.isSelected).toBe(true);
  });

  it("disables dates outside min/max range", () => {
    const dp = datePicker({
      initialDate: new Date(2024, 0, 15),
      minDate: new Date(2024, 0, 10),
      maxDate: new Date(2024, 0, 20),
    });

    expect(dp.isDateDisabled(new Date(2024, 0, 5))).toBe(true);
    expect(dp.isDateDisabled(new Date(2024, 0, 15))).toBe(false);
    expect(dp.isDateDisabled(new Date(2024, 0, 25))).toBe(true);

    // Selecting a disabled date should not change selection
    dp.select(new Date(2024, 0, 5));
    // Selected date should remain the initial date
    expect(dp.selectedDate()?.getDate()).toBe(15);
  });
});
