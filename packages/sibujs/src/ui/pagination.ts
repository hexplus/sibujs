import { derived } from "@sibujs/core";
import { signal } from "@sibujs/core";

/**
 * pagination provides reactive pagination state and controls.
 */
export function pagination(options: { totalItems: () => number; pageSize?: number; initialPage?: number }): {
  page: () => number;
  pageSize: () => number;
  totalPages: () => number;
  next: () => void;
  prev: () => void;
  goTo: (page: number) => void;
  startIndex: () => number;
  endIndex: () => number;
} {
  const pageSizeValue = options.pageSize ?? 10;
  const [page, setPage] = signal(options.initialPage ?? 1);
  const [pageSize] = signal(pageSizeValue);

  const totalPages = derived(() => {
    const total = options.totalItems();
    return Math.max(1, Math.ceil(total / pageSizeValue));
  });

  // The exposed page is clamped to the valid range, so when totalItems shrinks
  // below the current page, page()/startIndex()/endIndex() stay in bounds
  // instead of pointing past the data.
  const currentPage = derived(() => Math.min(Math.max(1, page()), totalPages()));

  const startIndex = derived(() => {
    return (currentPage() - 1) * pageSizeValue;
  });

  const endIndex = derived(() => {
    const end = currentPage() * pageSizeValue;
    const total = options.totalItems();
    return Math.min(end, total);
  });

  function next(): void {
    if (currentPage() < totalPages()) {
      setPage(currentPage() + 1);
    }
  }

  function prev(): void {
    if (currentPage() > 1) {
      setPage(currentPage() - 1);
    }
  }

  function goTo(target: number): void {
    const clamped = Math.max(1, Math.min(target, totalPages()));
    setPage(clamped);
  }

  return { page: currentPage, pageSize, totalPages, next, prev, goTo, startIndex, endIndex };
}
