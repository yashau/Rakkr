import type { PaginationMeta } from "@rakkr/shared";

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { paginationSummary } from "@/lib/server-pagination";
import { cn } from "@/lib/utils";

export interface DataTablePaginationProps {
  meta: PaginationMeta | undefined;
  onNext: () => void;
  onPageSizeChange: (size: number) => void;
  onPrevious: () => void;
  pageSize: number;
  pageSizes: number[];
}

export function DataTablePagination({
  meta,
  onNext,
  onPageSizeChange,
  onPrevious,
  pageSize,
  pageSizes,
}: DataTablePaginationProps) {
  const summary = paginationSummary(meta);
  const hasPrevious = meta?.hasPreviousPage ?? false;
  const hasNext = meta?.hasNextPage ?? false;

  return (
    <div className="flex flex-col gap-3 px-1 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        {summary.total === 0
          ? "No results"
          : `Showing ${summary.from}–${summary.to} of ${summary.total}`}
      </p>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows per page</span>
          <Select
            onValueChange={(value) => onPageSizeChange(Number(value))}
            value={String(pageSize)}
          >
            <SelectTrigger className="h-8 w-18" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                aria-disabled={!hasPrevious}
                className={cn(!hasPrevious && "pointer-events-none opacity-50")}
                href="#"
                onClick={(event) => {
                  event.preventDefault();

                  if (hasPrevious) {
                    onPrevious();
                  }
                }}
                tabIndex={hasPrevious ? undefined : -1}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                aria-disabled={!hasNext}
                className={cn(!hasNext && "pointer-events-none opacity-50")}
                href="#"
                onClick={(event) => {
                  event.preventDefault();

                  if (hasNext) {
                    onNext();
                  }
                }}
                tabIndex={hasNext ? undefined : -1}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
