import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

const boundDatePickers = new WeakMap<HTMLElement, () => void>();

export interface DatePickerOptions {
  initialDate?: Date;
  minDate?: Date;
  maxDate?: Date;
}

export function datePicker(options?: DatePickerOptions): {
  selectedDate: () => Date | null;
  select: (date: Date) => void;
  viewDate: () => Date;
  setViewDate: (date: Date) => void;
  nextMonth: () => void;
  prevMonth: () => void;
  nextYear: () => void;
  prevYear: () => void;
  daysInMonth: () => Array<{
    date: Date;
    isCurrentMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
    isDisabled: boolean;
  }>;
  isDateDisabled: (date: Date) => boolean;
  isSelected: (date: Date) => boolean;
  /** WAI-ARIA Date Picker dialog grid wiring: `role=grid`, arrow nav,
   *  PageUp/Down (month), Shift+PageUp/Down (year), Home/End. */
  bind: (els: { grid: HTMLElement; cell: (date: Date) => HTMLElement | null }) => () => void;
} {
  const minDate = options?.minDate;
  const maxDate = options?.maxDate;
  const initialDate = options?.initialDate ?? null;

  const [selectedDate, setSelectedDate] = signal<Date | null>(initialDate);
  const [viewDate, setViewDate] = signal<Date>(initialDate ?? new Date());

  function isDateDisabled(date: Date): boolean {
    const d = stripTime(date);
    if (minDate && d < stripTime(minDate)) return true;
    if (maxDate && d > stripTime(maxDate)) return true;
    return false;
  }

  function stripTime(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function select(date: Date): void {
    if (!isDateDisabled(date)) {
      setSelectedDate(date);
    }
  }

  // Use day=1 anchor before shifting month/year so .setMonth/.setFullYear
  // never overflow into the following month (e.g. Jan 31 → Feb → Mar 3).
  function shiftMonth(prev: Date, delta: number): Date {
    return new Date(prev.getFullYear(), prev.getMonth() + delta, 1);
  }

  function nextMonth(): void {
    setViewDate((prev) => shiftMonth(prev, 1));
  }

  function prevMonth(): void {
    setViewDate((prev) => shiftMonth(prev, -1));
  }

  function nextYear(): void {
    setViewDate((prev) => new Date(prev.getFullYear() + 1, prev.getMonth(), 1));
  }

  function prevYear(): void {
    setViewDate((prev) => new Date(prev.getFullYear() - 1, prev.getMonth(), 1));
  }

  const daysInMonth = derived(() => {
    const vd = viewDate();
    const year = vd.getFullYear();
    const month = vd.getMonth();
    const today = new Date();
    const selected = selectedDate();

    // First day of the month
    const firstDay = new Date(year, month, 1);
    // Day of week for first day (0 = Sunday)
    const startDow = firstDay.getDay();

    // Last day of the month
    const lastDay = new Date(year, month + 1, 0);
    const totalDaysInMonth = lastDay.getDate();

    const days: Array<{
      date: Date;
      isCurrentMonth: boolean;
      isToday: boolean;
      isSelected: boolean;
      isDisabled: boolean;
    }> = [];

    // Fill leading days from previous month
    for (let i = startDow - 1; i >= 0; i--) {
      const date = new Date(year, month, -i);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: sameDay(date, today),
        isSelected: selected !== null && sameDay(date, selected),
        isDisabled: isDateDisabled(date),
      });
    }

    // Fill current month days
    for (let d = 1; d <= totalDaysInMonth; d++) {
      const date = new Date(year, month, d);
      days.push({
        date,
        isCurrentMonth: true,
        isToday: sameDay(date, today),
        isSelected: selected !== null && sameDay(date, selected),
        isDisabled: isDateDisabled(date),
      });
    }

    // Fill trailing days to complete the last week (rows of 7)
    const remaining = days.length % 7;
    if (remaining > 0) {
      const trailingCount = 7 - remaining;
      for (let i = 1; i <= trailingCount; i++) {
        const date = new Date(year, month + 1, i);
        days.push({
          date,
          isCurrentMonth: false,
          isToday: sameDay(date, today),
          isSelected: selected !== null && sameDay(date, selected),
          isDisabled: isDateDisabled(date),
        });
      }
    }

    return days;
  });

  /** Check if a specific date is selected (reactive — safe inside each/map) */
  function isSelected(date: Date): boolean {
    const sel = selectedDate();
    return sel !== null && sameDay(date, sel);
  }

  return {
    selectedDate,
    select,
    viewDate,
    setViewDate,
    nextMonth,
    prevMonth,
    nextYear,
    prevYear,
    daysInMonth,
    isDateDisabled,
    /** Reactive check — use inside class bindings for per-day reactivity */
    isSelected,
    bind,
  };

  function bind(els: { grid: HTMLElement; cell: (date: Date) => HTMLElement | null }): () => void {
    const existing = boundDatePickers.get(els.grid);
    if (existing) return existing;

    els.grid.setAttribute("role", "grid");
    if (els.grid.tabIndex < 0) els.grid.tabIndex = 0;

    const fxTeardown = effect(() => {
      const sel = selectedDate();
      const view = viewDate();
      const days = daysInMonth();
      for (const d of days) {
        const cell = els.cell(d.date);
        if (!cell) continue;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-selected", sel && isSameCalendarDay(sel, d.date) ? "true" : "false");
        if (d.isDisabled) cell.setAttribute("aria-disabled", "true");
        else cell.removeAttribute("aria-disabled");
        // Roving tabindex on focused-day (view date) cell.
        cell.tabIndex = isSameCalendarDay(view, d.date) ? 0 : -1;
      }
    });

    function isSameCalendarDay(a: Date, b: Date): boolean {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    function shiftDays(delta: number): void {
      setViewDate((prev) => new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + delta));
    }

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          shiftDays(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          shiftDays(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          shiftDays(-7);
          break;
        case "ArrowDown":
          e.preventDefault();
          shiftDays(7);
          break;
        case "Home":
          e.preventDefault();
          setViewDate((p) => new Date(p.getFullYear(), p.getMonth(), p.getDate() - p.getDay()));
          break;
        case "End": {
          e.preventDefault();
          setViewDate((p) => new Date(p.getFullYear(), p.getMonth(), p.getDate() + (6 - p.getDay())));
          break;
        }
        case "PageUp":
          e.preventDefault();
          if (e.shiftKey) prevYear();
          else prevMonth();
          break;
        case "PageDown":
          e.preventDefault();
          if (e.shiftKey) nextYear();
          else nextMonth();
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          select(viewDate());
          break;
      }
    };
    els.grid.addEventListener("keydown", onKey);

    const teardown = () => {
      boundDatePickers.delete(els.grid);
      fxTeardown();
      els.grid.removeEventListener("keydown", onKey);
    };
    boundDatePickers.set(els.grid, teardown);
    return teardown;
  }
}
