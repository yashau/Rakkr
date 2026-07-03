import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";

import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  id: string;
  label: string;
  sublabel?: string;
  /** Extra text folded into the search match (e.g. an id or email). */
  keywords?: string;
}

export interface ComboboxGroup {
  heading?: string;
  icon?: React.ComponentType<{ className?: string }>;
  options: ComboboxOption[];
}

interface ComboboxProps {
  groups: ComboboxGroup[];
  onSelect: (option: ComboboxOption) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** When provided, options render a trailing check for members of the set. */
  selectedIds?: ReadonlySet<string>;
  /** Multi-select fields keep the list open after a pick; single-select closes. */
  closeOnSelect?: boolean;
  ariaLabel?: string;
  /** Fires when the option list opens/closes (e.g. to lazily load options). */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Inline combobox: the field itself is the search input, and matching options
 * fade in as a dropdown directly beneath it — no separate popover trigger and
 * no second search box. Built on cmdk so type-ahead filtering and arrow-key
 * navigation work while focus stays in the field.
 */
export function Combobox({
  groups,
  onSelect,
  placeholder = "Search…",
  emptyText = "No results.",
  disabled = false,
  selectedIds,
  closeOnSelect = false,
  ariaLabel,
  onOpenChange,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);

  function openList() {
    setOpen(true);
    onOpenChange?.(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
    onOpenChange?.(false);
  }

  return (
    <CommandPrimitive className="relative overflow-visible bg-transparent">
      <div
        className="relative"
        onBlur={(event) => {
          // Only collapse when focus leaves the field *and* its dropdown.
          if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
            close();
          }
        }}
        ref={rootRef}
      >
        <div
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <CommandPrimitive.Input
            aria-label={ariaLabel}
            className="flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            disabled={disabled}
            onFocus={() => openList()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.blur();
                close();
              }
            }}
            onValueChange={setQuery}
            placeholder={placeholder}
            value={query}
          />
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </div>

        {open && !disabled ? (
          <div
            // Keep focus in the input when an option is clicked so the pick
            // registers before the blur-to-close fires. The div only positions
            // the listbox, so it carries a presentation role.
            className="absolute top-full left-0 z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0"
            onMouseDown={(event) => event.preventDefault()}
            role="presentation"
          >
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              {groups.map((group, groupIndex) =>
                group.options.length > 0 ? (
                  <CommandGroup heading={group.heading} key={group.heading ?? groupIndex}>
                    {group.options.map((option) => {
                      const Icon = group.icon;

                      return (
                        <CommandItem
                          key={option.id}
                          onSelect={() => {
                            onSelect(option);
                            setQuery("");
                            if (closeOnSelect) {
                              close();
                            }
                          }}
                          value={`${option.label} ${option.sublabel ?? ""} ${option.keywords ?? ""} ${option.id}`}
                        >
                          {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{option.label}</span>
                            {option.sublabel ? (
                              <span className="truncate text-xs text-muted-foreground">
                                {option.sublabel}
                              </span>
                            ) : null}
                          </span>
                          {selectedIds ? (
                            <Check
                              className={cn(
                                "size-4",
                                selectedIds.has(option.id) ? "opacity-100" : "opacity-0",
                              )}
                            />
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null,
              )}
            </CommandList>
          </div>
        ) : null}
      </div>
    </CommandPrimitive>
  );
}
