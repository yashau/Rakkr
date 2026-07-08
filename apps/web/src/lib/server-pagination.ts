import type { PaginationMeta } from "@rakkr/shared";

export const defaultPageSizes = [10, 25, 50, 100] as const;
export const defaultPageSize = 50;

/** Zero-based offset for a 1-based page number. */
export function offsetForPage(page: number, limit: number): number {
  return Math.max(page - 1, 0) * Math.max(limit, 1);
}

/** 1-based page number for a given offset/limit. */
export function currentPageFromOffset(offset: number, limit: number): number {
  if (limit <= 0) {
    return 1;
  }

  return Math.floor(Math.max(offset, 0) / limit) + 1;
}

/**
 * Clamp an offset back onto the last non-empty page when the total shrinks below
 * it — e.g. the rows on the last page are deleted (bulk delete / retention sweep /
 * single delete). Without this, a server-paginated list strands the user on an
 * empty page past the end with only "Previous" to escape. Returns 0 for an empty
 * list or a non-positive offset; leaves a still-valid offset untouched.
 */
export function clampedOffset(offset: number, limit: number, total: number): number {
  if (offset <= 0 || limit <= 0) {
    return Math.max(offset, 0);
  }

  if (total <= 0) {
    return 0;
  }

  if (offset < total) {
    return offset;
  }

  return Math.max(Math.ceil(total / limit) - 1, 0) * limit;
}

export interface PaginationSummary {
  from: number;
  to: number;
  total: number;
}

/** "Showing {from}–{to} of {total}" numbers, safe for empty/undefined meta. */
export function paginationSummary(meta: PaginationMeta | undefined): PaginationSummary {
  if (!meta || meta.total === 0 || meta.returned === 0) {
    return { from: 0, to: 0, total: meta?.total ?? 0 };
  }

  return {
    from: meta.offset + 1,
    to: meta.offset + meta.returned,
    total: meta.total,
  };
}

/**
 * Shallow value-equality over two filter objects. Filter drafts are rebuilt
 * every render, so the pagination hook compares by value (not identity) to
 * decide whether to reset to the first page.
 */
export function shallowFiltersEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => Object.is(left[key], right[key]));
}
