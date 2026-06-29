import { z } from "zod";
import type { PaginatedResponse, PaginationMeta } from "@rakkr/shared";

export interface PagePolicy {
  defaultLimit: number;
  maxLimit: number;
}

/**
 * Per-resource page-size policy. Audit/health keep the historical 500 ceiling;
 * everything else defaults to a conservative 50/200.
 */
export const PAGE_POLICY = {
  audit: { defaultLimit: 100, maxLimit: 500 },
  default: { defaultLimit: 50, maxLimit: 200 },
  health: { defaultLimit: 100, maxLimit: 500 },
} as const satisfies Record<string, PagePolicy>;

/**
 * Zod query fields to spread into each list route's query schema so every
 * endpoint accepts `limit`/`offset` identically. Empty/blank params are treated
 * as unset; `limit=0` or out-of-range values fail validation (400).
 */
export const paginationQueryFields = {
  limit: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? Number(value) : undefined),
    z.number().int().min(1).max(500).optional(),
  ),
  offset: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? Number(value) : undefined),
    z.number().int().nonnegative().optional(),
  ),
};

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Parse a raw query-string value into a finite number, or undefined when blank. */
export function numberFromQuery(value: string | undefined): number | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve a concrete `{ limit, offset }` for the DB query: applies the
 * resource default when `limit` is unset and clamps it to the policy ceiling.
 */
export function parsePagination(input: PaginationInput, policy: PagePolicy) {
  const limit = Math.min(Math.max(input.limit ?? policy.defaultLimit, 1), policy.maxLimit);
  const offset = Math.max(input.offset ?? 0, 0);

  return { limit, offset };
}

/** Build the response meta for the SQL path (data via LIMIT/OFFSET, total via COUNT). */
export function buildPaginationMeta(args: {
  limit: number;
  offset: number;
  returned: number;
  total: number;
}): PaginationMeta {
  const { limit, offset, returned, total } = args;

  return {
    hasNextPage: offset + returned < total,
    hasPreviousPage: offset > 0,
    limit,
    offset,
    returned,
    total,
  };
}

/**
 * In-memory pagination over an already-filtered/scoped array. Mirrors the
 * original recordings behavior: an absent `limit` returns every row. Used by
 * recordings and by the in-memory fallback stores so they match the SQL path.
 */
export function paginate<T>(items: T[], input: PaginationInput): PaginatedResponse<T> {
  const offset = Math.max(input.offset ?? 0, 0);

  if (input.limit === undefined) {
    return {
      data: items,
      meta: {
        hasNextPage: false,
        hasPreviousPage: offset > 0,
        offset,
        returned: items.length,
        total: items.length,
      },
    };
  }

  const data = items.slice(offset, offset + input.limit);

  return {
    data,
    meta: {
      hasNextPage: offset + data.length < items.length,
      hasPreviousPage: offset > 0,
      limit: input.limit,
      offset,
      returned: data.length,
      total: items.length,
    },
  };
}
