import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  type OnChangeFn,
  type RowData,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { Fragment, type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TruncateCell } from "@/components/ui/truncate-cell";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    cellClassName?: string;
    headClassName?: string;
    // A `max-w-*` utility sized to the column's likely data. When set, the cell's
    // content is capped at that width and truncated with an ellipsis plus a hover
    // tooltip revealing the full value. Leave unset for short columns (badges,
    // dates, counts), action columns, and multi-line cells that truncate each
    // line internally with their own TruncateCell.
    truncateClassName?: string;
  }
}

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  emptyMessage?: ReactNode;
  enableRowSelection?: boolean;
  getRowId?: (row: TData, index: number) => string;
  isLoading?: boolean;
  onRowClick?: (row: TData) => void;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  onSortingChange?: OnChangeFn<SortingState>;
  renderExpandedRow?: (row: TData) => ReactNode;
  rowSelection?: RowSelectionState;
  // Server-side sorting state. When provided, sorting is manual (server-driven).
  sorting?: SortingState;
  skeletonRows?: number;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  emptyMessage = "No results.",
  enableRowSelection,
  getRowId,
  isLoading,
  onRowClick,
  onRowSelectionChange,
  onSortingChange,
  renderExpandedRow,
  rowSelection,
  sorting,
  skeletonRows = 8,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    columns,
    data,
    enableRowSelection,
    enableSorting: Boolean(onSortingChange),
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: renderExpandedRow ? getExpandedRowModel() : undefined,
    getRowCanExpand: renderExpandedRow ? () => true : undefined,
    getRowId,
    manualPagination: true,
    manualSorting: Boolean(onSortingChange),
    onRowSelectionChange,
    onSortingChange,
    state: {
      ...(sorting ? { sorting } : {}),
      ...(rowSelection ? { rowSelection } : {}),
    },
  });

  const columnCount = table.getAllLeafColumns().length;

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={cn("whitespace-nowrap", header.column.columnDef.meta?.headClassName)}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: skeletonRows }).map((_, rowIndex) => (
              <TableRow key={`skeleton-${rowIndex}`}>
                {Array.from({ length: columnCount }).map((__, cellIndex) => (
                  <TableCell key={`skeleton-${rowIndex}-${cellIndex}`}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell className="h-24 text-center text-muted-foreground" colSpan={columnCount}>
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <Fragment key={row.id}>
                <TableRow
                  className={cn(onRowClick && "cursor-pointer")}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    const content = flexRender(cell.column.columnDef.cell, cell.getContext());

                    return (
                      <TableCell
                        key={cell.id}
                        className={cn("whitespace-nowrap", meta?.cellClassName)}
                      >
                        {meta?.truncateClassName ? (
                          <TruncateCell className={meta.truncateClassName}>{content}</TruncateCell>
                        ) : (
                          content
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
                {renderExpandedRow && row.getIsExpanded() ? (
                  <TableRow data-expanded="true">
                    <TableCell className="bg-muted/30 p-0" colSpan={columnCount}>
                      {renderExpandedRow(row.original)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
