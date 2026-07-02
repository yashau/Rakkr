import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import type { AssigneeOption } from "@/components/assignee-multi-select";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Canonical shadcn single-select combobox (Popover + Command) for picking one
// user or group. Used by the access-policy composer so every user/group
// assignment field is the same searchable control.
export function SubjectCombobox({
  disabled = false,
  emptyLabel = "No matches found.",
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  value,
}: {
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (id: string) => void;
  options: AssigneeOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-haspopup="listbox"
          className="h-9 justify-between font-normal"
          disabled={disabled}
          type="button"
          variant="outline"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.label ?? (value || placeholder)}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.id}
                onSelect={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                value={`${option.label} ${option.sublabel ?? ""} ${option.id}`}
              >
                <span className="flex flex-1 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.sublabel ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {option.sublabel}
                    </span>
                  ) : null}
                </span>
                <Check
                  className={cn("size-4", option.id === value ? "opacity-100" : "opacity-0")}
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
