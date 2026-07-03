import { Users, UserRound, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

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

// Inline combobox for picking multiple users and/or access groups: the field
// itself filters as you type, picks toggle (the list stays open), and selection
// is echoed as removable badges. Ids are namespaced so one combobox routes both
// kinds. The label/emptyLabel/searchPlaceholder props let single-subject
// wrappers (users-only / groups-only) retune the copy without duplicating it.
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
  const selectedUsers = new Set(selectedUserIds);
  const selectedGroups = new Set(selectedGroupIds);

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

  const comboboxGroups: ComboboxGroup[] = [
    {
      heading: "Access groups",
      icon: Users,
      options: groupOptions.map((option) => ({
        id: `group:${option.id}`,
        keywords: option.id,
        label: option.label,
        sublabel: option.sublabel,
      })),
    },
    {
      heading: "Users",
      icon: UserRound,
      options: userOptions.map((option) => ({
        id: `user:${option.id}`,
        keywords: option.id,
        label: option.label,
        sublabel: option.sublabel,
      })),
    },
  ];

  const selectedIds = new Set([
    ...selectedGroupIds.map((id) => `group:${id}`),
    ...selectedUserIds.map((id) => `user:${id}`),
  ]);

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
      <Combobox
        ariaLabel={label}
        disabled={disabled}
        emptyText={emptyLabel}
        groups={comboboxGroups}
        onSelect={(option) => {
          const separator = option.id.indexOf(":");
          const kind = option.id.slice(0, separator);
          const rawId = option.id.slice(separator + 1);
          if (kind === "group") {
            toggleGroup(rawId);
          } else {
            toggleUser(rawId);
          }
        }}
        placeholder={searchPlaceholder}
        selectedIds={selectedIds}
      />

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
