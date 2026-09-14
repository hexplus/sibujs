import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";

export interface PaginationResult {
  page: () => number;
  pageSize: () => number;
  totalPages: () => number;
  next: () => void;
  prev: () => void;
  goTo: (page: number) => void;
  startIndex: () => number;
  endIndex: () => number;
  /**
   * Release the subscriptions to `totalItems`. Call it when the pagination is
   * discarded before the state it reads. Afterwards the accessors return their
   * last values and the controls no longer move the page. Idempotent.
   */
  dispose: () => void;
}

/**
 * pagination provides reactive pagination state and controls.
 *
 * It subscribes to the caller's `totalItems` getter, which usually lives longer
 * than the pagination itself (a store, a query result). Call `dispose()` when
 * the pagination is no longer used, e.g. `onUnmount(pager.dispose, el)`.
 */
export function pagination(options: {
  totalItems: () => number;
  pageSize?: number;
  initialPage?: number;
}): PaginationResult {
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

  // Dependents first, so no disposed derived is ever read by a live one.
  // `derived().dispose()` is idempotent, which makes this idempotent too.
  function dispose(): void {
    startIndex.dispose();
    endIndex.dispose();
    currentPage.dispose();
    totalPages.dispose();
  }

  return { page: currentPage, pageSize, totalPages, next, prev, goTo, startIndex, endIndex, dispose };
}
