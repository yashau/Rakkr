import { Check, ChevronsUpDown, Users, UserRound, X } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface AssigneeOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface AssigneeMultiSelectProps {
  disabled?: boolean;
  emptyLabel?: string;
  groupOptions: AssigneeOption[];
  label?: string;
  onChange: (next: { groupIds: string[]; userIds: string[] }) => void;
  searchPlaceholder?: string;
  selectedGroupIds: string[];
  selectedUserIds: string[];
  userOptions: AssigneeOption[];
}

// Canonical shadcn combobox (Popover + Command) composed for picking multiple
// users and/or access groups. Selection is echoed as removable badges. The label
// props let single-subject wrappers (users-only / groups-only) retune the copy
// without duplicating the combobox.
export function AssigneeMultiSelect({
  disabled = false,
  emptyLabel = "No users or groups found.",
  groupOptions,
  label = "Assign users or groups",
  onChange,
  searchPlaceholder = "Search users and groups…",
  selectedGroupIds,
  selectedUserIds,
  userOptions,
}: AssigneeMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedUsers = new Set(selectedUserIds);
  const selectedGroups = new Set(selectedGroupIds);
  const totalSelected = selectedUsers.size + selectedGroups.size;

  function toggleUser(id: string) {
    const next = new Set(selectedUsers);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange({ groupIds: [...selectedGroups], userIds: [...next] });
  }

  function toggleGroup(id: string) {
    const next = new Set(selectedGroups);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange({ groupIds: [...next], userIds: [...selectedUsers] });
  }

  const chips = [
    ...selectedUserIds.map((id) => ({
      id,
      kind: "user" as const,
      label: userOptions.find((option) => option.id === id)?.label ?? id,
    })),
    ...selectedGroupIds.map((id) => ({
      id,
      kind: "group" as const,
      label: groupOptions.find((option) => option.id === id)?.label ?? id,
    })),
  ];

  return (
    <div className="grid gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            aria-haspopup="listbox"
            className="justify-between font-normal"
            disabled={disabled}
            type="button"
            variant="outline"
          >
            <span className={cn(totalSelected === 0 && "text-muted-foreground")}>
              {totalSelected === 0
                ? label
                : `${totalSelected} assignee${totalSelected === 1 ? "" : "s"}`}
            </span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              {groupOptions.length > 0 ? (
                <CommandGroup heading="Access groups">
                  {groupOptions.map((option) => (
                    <CommandItem
                      key={`group-${option.id}`}
                      onSelect={() => toggleGroup(option.id)}
                      value={`group ${option.label} ${option.id}`}
                    >
                      <Users className="size-4 text-muted-foreground" />
                      <span className="flex-1 truncate">{option.label}</span>
                      <Check
                        className={cn(
                          "size-4",
                          selectedGroups.has(option.id) ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {userOptions.length > 0 ? (
                <CommandGroup heading="Users">
                  {userOptions.map((option) => (
                    <CommandItem
                      key={`user-${option.id}`}
                      onSelect={() => toggleUser(option.id)}
                      value={`user ${option.label} ${option.sublabel ?? ""} ${option.id}`}
                    >
                      <UserRound className="size-4 text-muted-foreground" />
                      <span className="flex flex-1 flex-col">
                        <span className="truncate">{option.label}</span>
                        {option.sublabel ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {option.sublabel}
                          </span>
                        ) : null}
                      </span>
                      <Check
                        className={cn(
                          "size-4",
                          selectedUsers.has(option.id) ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Badge className="gap-1 pr-1" key={`${chip.kind}-${chip.id}`} variant="secondary">
              {chip.kind === "group" ? (
                <Users className="size-3" />
              ) : (
                <UserRound className="size-3" />
              )}
              <span className="max-w-40 truncate">{chip.label}</span>
              <button
                aria-label={`Remove ${chip.label}`}
                className="rounded-sm opacity-70 hover:opacity-100"
                disabled={disabled}
                onClick={() => (chip.kind === "group" ? toggleGroup(chip.id) : toggleUser(chip.id))}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
