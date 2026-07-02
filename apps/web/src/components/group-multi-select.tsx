import { AssigneeMultiSelect, type AssigneeOption } from "@/components/assignee-multi-select";

// Groups-only wrapper over the canonical AssigneeMultiSelect combobox. Used
// everywhere access groups are assigned (user access dialogs, etc.) so the picker
// stays a single shadcn component instead of a bespoke widget per surface.
export function GroupMultiSelect({
  disabled = false,
  groupOptions,
  onChange,
  selectedGroupIds,
}: {
  disabled?: boolean;
  groupOptions: AssigneeOption[];
  onChange: (groupIds: string[]) => void;
  selectedGroupIds: string[];
}) {
  return (
    <AssigneeMultiSelect
      disabled={disabled}
      emptyLabel="No access groups found."
      groupOptions={groupOptions}
      label="Assign access groups"
      onChange={(next) => onChange(next.groupIds)}
      searchPlaceholder="Search access groups…"
      selectedGroupIds={selectedGroupIds}
      selectedUserIds={[]}
      userOptions={[]}
    />
  );
}
