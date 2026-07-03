import * as React from "react";

import {
  Combobox as ComboboxRoot,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";

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

interface GroupData {
  heading?: string;
  icon?: React.ComponentType<{ className?: string }>;
  items: ComboboxOption[];
}

interface ComboboxProps {
  groups: ComboboxGroup[];
  onSelect: (option: ComboboxOption) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** When provided, options render Base UI's selected check for members of the set. */
  selectedIds?: ReadonlySet<string>;
  /** Multi-select fields keep the list open after a pick; single-select closes. */
  closeOnSelect?: boolean;
  ariaLabel?: string;
  /** Fires when the option list opens/closes (e.g. to lazily load options). */
  onOpenChange?: (open: boolean) => void;
}

function itemToLabel(option: ComboboxOption) {
  return `${option.label} ${option.sublabel ?? ""} ${option.keywords ?? ""} ${option.id}`;
}

function sameOption(a: ComboboxOption, b: ComboboxOption) {
  return a.id === b.id;
}

function ComboboxItemRow({
  icon: Icon,
  option,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  option: ComboboxOption;
}) {
  return (
    <ComboboxItem key={option.id} value={option}>
      {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{option.label}</span>
        {option.sublabel ? (
          <span className="truncate text-xs text-muted-foreground">{option.sublabel}</span>
        ) : null}
      </span>
    </ComboboxItem>
  );
}

/**
 * Searchable, grouped combobox (Base UI / canonical shadcn) for picking users,
 * groups, rooms, etc. The field is the search input and matching options filter
 * as you type, split under group headings. Single-select fields (`closeOnSelect`)
 * collapse after a pick; multi-select fields keep the list open and render Base
 * UI's selected check for members of `selectedIds`.
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
  const data: GroupData[] = groups
    .filter((group) => group.options.length > 0)
    .map((group) => ({ heading: group.heading, icon: group.icon, items: group.options }));

  const allOptions = React.useMemo(() => groups.flatMap((group) => group.options), [groups]);

  const list = (
    <ComboboxContent>
      <ComboboxEmpty>{emptyText}</ComboboxEmpty>
      <ComboboxList>
        <ComboboxCollection>
          {(group: GroupData) => (
            <ComboboxGroup items={group.items} key={group.heading ?? "group"}>
              {group.heading ? <ComboboxLabel>{group.heading}</ComboboxLabel> : null}
              <ComboboxCollection>
                {(option: ComboboxOption) => (
                  <ComboboxItemRow icon={group.icon} key={option.id} option={option} />
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxCollection>
      </ComboboxList>
    </ComboboxContent>
  );

  const input = (
    <ComboboxInput aria-label={ariaLabel} disabled={disabled} placeholder={placeholder} />
  );

  // Multi-select: Base UI tracks the selected set (built-in check indicators) and
  // keeps the popup open; we derive the single toggled option for the caller.
  if (!closeOnSelect && selectedIds) {
    const value = allOptions.filter((option) => selectedIds.has(option.id));
    return (
      <ComboboxRoot
        disabled={disabled}
        isItemEqualToValue={sameOption}
        itemToStringLabel={itemToLabel}
        items={data}
        multiple
        onOpenChange={(open) => onOpenChange?.(open)}
        onValueChange={(next: ComboboxOption[]) => {
          const nextIds = new Set(next.map((option) => option.id));
          const toggled = allOptions.find(
            (option) => nextIds.has(option.id) !== selectedIds.has(option.id),
          );
          if (toggled) {
            onSelect(toggled);
          }
        }}
        value={value}
      >
        {input}
        {list}
      </ComboboxRoot>
    );
  }

  // Single-select emitter: nothing sticks in the field; each pick fires `onSelect`
  // and the popup closes.
  return (
    <ComboboxRoot
      disabled={disabled}
      isItemEqualToValue={sameOption}
      itemToStringLabel={itemToLabel}
      items={data}
      onOpenChange={(open) => onOpenChange?.(open)}
      onValueChange={(option: ComboboxOption | null) => {
        if (option) {
          onSelect(option);
        }
      }}
      value={null}
    >
      {input}
      {list}
    </ComboboxRoot>
  );
}
