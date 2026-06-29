import { z } from "zod";

/**
 * Shared server-side pagination contract used by every list endpoint.
 *
 * Field names are a superset of the original recordings meta so existing
 * recordings clients keep working unchanged. The whole codebase paginates with
 * `limit`/`offset` (never `page`/`pageSize`).
 */
export const paginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

export interface PaginationMeta {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  limit?: number;
  offset: number;
  returned: number;
  total: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}
