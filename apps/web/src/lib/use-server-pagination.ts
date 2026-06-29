import { useRef, useState } from "react";

import {
  currentPageFromOffset,
  defaultPageSize,
  defaultPageSizes,
  shallowFiltersEqual,
} from "./server-pagination";

export interface ServerPaginationOptions {
  defaultPageSize?: number;
  pageSizes?: number[];
}

export interface ServerPagination<F extends object> {
  /** Filters merged with the current page window, for the query key + request. */
  query: F & { limit: number; offset: number };
  limit: number;
  offset: number;
  page: number;
  pageSize: number;
  pageSizes: number[];
  setPageSize: (size: number) => void;
  nextPage: () => void;
  previousPage: () => void;
  resetToFirstPage: () => void;
}

/**
 * Owns the `{ limit, offset }` window for a server-paginated list and resets to
 * the first page whenever the (value-compared) filter object changes. Pair the
 * consuming `useQuery` with `placeholderData: keepPreviousData` for flicker-free
 * page transitions.
 */
export function useServerPagination<F extends object>(
  filters: F,
  options?: ServerPaginationOptions,
): ServerPagination<F> {
  const pageSizes = options?.pageSizes ?? [...defaultPageSizes];
  const [pageSize, setPageSizeState] = useState(options?.defaultPageSize ?? defaultPageSize);
  const [offset, setOffset] = useState(0);
  const previousFilters = useRef<F>(filters);

  // Adjust state during render when filters change (React's documented pattern):
  // a new filter set always returns to the first page.
  if (
    !shallowFiltersEqual(
      previousFilters.current as Record<string, unknown>,
      filters as Record<string, unknown>,
    )
  ) {
    previousFilters.current = filters;

    if (offset !== 0) {
      setOffset(0);
    }
  }

  return {
    limit: pageSize,
    nextPage: () => setOffset((current) => current + pageSize),
    offset,
    page: currentPageFromOffset(offset, pageSize),
    pageSize,
    pageSizes,
    previousPage: () => setOffset((current) => Math.max(current - pageSize, 0)),
    query: { ...filters, limit: pageSize, offset },
    resetToFirstPage: () => setOffset(0),
    setPageSize: (size: number) => {
      setPageSizeState(size);
      setOffset(0);
    },
  };
}
