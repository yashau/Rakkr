import { type ReactNode, useState } from "react";
import { Filter, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface FilterChipDescriptor {
  key: string;
  label: string;
  value: string;
}

/**
 * Shared filter toolbar for the operations-console list pages. It keeps the
 * primary search inline, tucks every secondary filter behind a "Filters"
 * slide-out, and renders the active-filter chips in one consistent place.
 *
 * Pages keep ownership of their filter state: pass the secondary controls as
 * children (wrapped in {@link FilterField}), the active chips, and the clear
 * handlers. The chip count drives the badge on the Filters trigger, so pass the
 * chips that live inside the sheet (exclude the inline search chip).
 */
export function FilterToolbar({
  actions,
  chips,
  children,
  onClearAll,
  onClearChip,
  onSearchChange,
  search,
  searchPlaceholder = "Search",
  sheetDescription,
  sheetTitle = "Filters",
}: {
  /** Trailing controls (export, refresh, …) rendered at the end of the row. */
  actions?: ReactNode;
  /** Active secondary filters shown as removable chips and counted on the trigger. */
  chips: FilterChipDescriptor[];
  /** Secondary filter controls rendered inside the slide-out. */
  children?: ReactNode;
  onClearAll: () => void;
  onClearChip: (key: string) => void;
  /** Omit to hide the inline search box (pages without a free-text search). */
  onSearchChange?: (value: string) => void;
  search?: string;
  searchPlaceholder?: string;
  sheetDescription?: string;
  sheetTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = chips.length;
  const showSearch = onSearchChange !== undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {showSearch ? (
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search"
              className="bg-background pr-8 pl-9"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              value={search ?? ""}
            />
            {search ? (
              <button
                aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => onSearchChange("")}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
        {children ? (
          <Sheet onOpenChange={setOpen} open={open}>
            <SheetTrigger asChild>
              <Button type="button" variant="outline">
                <Filter className="size-4" />
                Filters
                {activeCount > 0 ? (
                  <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums">
                    {activeCount}
                  </span>
                ) : null}
              </Button>
            </SheetTrigger>
            <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
              <SheetHeader>
                <SheetTitle>{sheetTitle}</SheetTitle>
                {sheetDescription ? <SheetDescription>{sheetDescription}</SheetDescription> : null}
              </SheetHeader>
              <div className="-mx-6 flex-1 overflow-y-auto px-6 py-4">
                <div className="grid gap-4">{children}</div>
              </div>
              <SheetFooter className="gap-2 sm:flex-col sm:space-x-0">
                <Button className="w-full" onClick={onClearAll} type="button" variant="outline">
                  Reset filters
                </Button>
                <SheetClose asChild>
                  <Button className="w-full" type="button">
                    Show results
                  </Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        ) : null}
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{actions}</div>
        ) : null}
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <Badge
              className="max-w-full gap-1 overflow-hidden bg-background pr-1"
              key={chip.key}
              variant="outline"
            >
              <span className="shrink-0 text-muted-foreground">{chip.label}</span>
              <span className="truncate font-mono">{chip.value}</span>
              <button
                aria-label={`Clear ${chip.label} filter`}
                className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => onClearChip(chip.key)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            className="h-6 px-2 text-xs"
            onClick={onClearAll}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Label + control stack used for the secondary controls inside the slide-out. */
export function FilterField({
  children,
  className,
  description,
  label,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  label: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}
