import type { AssigneeOption } from "@/components/assignee-multi-select";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

// Single-select combobox (Base UI) for picking one user or group. Used by the
// access-policy composer so every user/group assignment field is the same
// searchable control. The input doubles as the search box and shows the
// current selection's label.
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
  const selected = options.find((option) => option.id === value) ?? null;

  return (
    <Combobox
      disabled={disabled}
      isItemEqualToValue={(a: AssigneeOption, b: AssigneeOption) => a.id === b.id}
      itemToStringLabel={(option: AssigneeOption) => option.label}
      items={options}
      onValueChange={(option: AssigneeOption | null) => onChange(option?.id ?? "")}
      value={selected}
    >
      <ComboboxInput
        aria-label={placeholder}
        disabled={disabled}
        placeholder={selected ? searchPlaceholder : placeholder}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          <ComboboxCollection>
            {(option: AssigneeOption) => (
              <ComboboxItem key={option.id} value={option}>
                <span className="flex flex-1 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.sublabel ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {option.sublabel}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            )}
          </ComboboxCollection>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
