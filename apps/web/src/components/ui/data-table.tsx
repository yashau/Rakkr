import {
  type Cell,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  type OnChangeFn,
  type Row,
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

// Columns that are chrome rather than data: rendered in the card header strip on
// mobile instead of as labelled fields.
const UTILITY_COLUMN_IDS = new Set(["select", "expand"]);

function isActionsColumn(id: string) {
  return id === "actions";
}

function columnLabel(header: unknown, fallback: string) {
  return typeof header === "string" ? header : fallback;
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
  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;

  return (
    <>
      {/* Mobile (<md): stacked cards. Dense multi-column tables are unreadable on
          a phone, so each row becomes a labelled card with actions in a footer. */}
      <div className="grid gap-3 md:hidden">
        {isLoading ? (
          Array.from({ length: Math.min(skeletonRows, 4) }).map((_, index) => (
            <div
              key={`card-skeleton-${index}`}
              className="grid gap-3 rounded-lg border border-border bg-card p-3 shadow-sm"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ))
        ) : hasRows ? (
          rows.map((row) => (
            <DataTableCard key={row.id} renderExpandedRow={renderExpandedRow} row={row} />
          ))
        ) : (
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
            {emptyMessage}
          </div>
        )}
      </div>

      {/* Desktop (md+): the full table. */}
      <div className="hidden rounded-md border border-border md:block">
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
            ) : !hasRows ? (
              <TableRow>
                <TableCell className="h-24 text-center text-muted-foreground" colSpan={columnCount}>
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
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
                            <TruncateCell className={meta.truncateClassName}>
                              {content}
                            </TruncateCell>
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
    </>
  );
}

// One row rendered as a mobile card: the first data column is the title, the rest
// are labelled fields, selection/expander chrome sits top-right, and the actions
// column becomes a footer. Cells are rendered with the same `cell` renderers as
// the table, so per-column formatting (badges, links, truncation) is preserved.
function DataTableCard<TData>({
  renderExpandedRow,
  row,
}: {
  renderExpandedRow?: (row: TData) => ReactNode;
  row: Row<TData>;
}) {
  const cells = row.getVisibleCells();
  const utilityCells = cells.filter((cell) => UTILITY_COLUMN_IDS.has(cell.column.id));
  const actionCells = cells.filter((cell) => isActionsColumn(cell.column.id));
  const fieldCells = cells.filter(
    (cell) => !UTILITY_COLUMN_IDS.has(cell.column.id) && !isActionsColumn(cell.column.id),
  );
  const [titleCell, ...detailCells] = fieldCells;

  const renderCell = (cell: Cell<TData, unknown>) =>
    flexRender(cell.column.columnDef.cell, cell.getContext());

  return (
    <div
      className={cn(
        "grid gap-2.5 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm",
        row.getIsSelected() && "ring-1 ring-primary/40",
      )}
      data-state={row.getIsSelected() ? "selected" : undefined}
    >
      {titleCell || utilityCells.length > 0 ? (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">{titleCell ? renderCell(titleCell) : null}</div>
          {utilityCells.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1">
              {utilityCells.map((cell) => (
                <Fragment key={cell.id}>{renderCell(cell)}</Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {detailCells.length > 0 ? (
        <dl className="grid gap-2">
          {detailCells.map((cell) => (
            <div className="grid grid-cols-[minmax(0,7rem)_1fr] items-baseline gap-3" key={cell.id}>
              <dt className="truncate text-xs text-muted-foreground">
                {columnLabel(cell.column.columnDef.header, cell.column.id)}
              </dt>
              <dd className="min-w-0 text-sm">{renderCell(cell)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {actionCells.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-2.5">
          {actionCells.map((cell) => (
            <Fragment key={cell.id}>{renderCell(cell)}</Fragment>
          ))}
        </div>
      ) : null}

      {renderExpandedRow && row.getIsExpanded() ? (
        <div className="border-t border-border pt-2.5">{renderExpandedRow(row.original)}</div>
      ) : null}
    </div>
  );
}
