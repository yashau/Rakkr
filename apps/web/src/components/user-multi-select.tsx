import { AssigneeMultiSelect, type AssigneeOption } from "@/components/assignee-multi-select";

// Users-only wrapper over the canonical AssigneeMultiSelect combobox. Used to pick
// group membership from the Access page.
export function UserMultiSelect({
  disabled = false,
  onChange,
  selectedUserIds,
  userOptions,
}: {
  disabled?: boolean;
  onChange: (userIds: string[]) => void;
  selectedUserIds: string[];
  userOptions: AssigneeOption[];
}) {
  return (
    <AssigneeMultiSelect
      disabled={disabled}
      emptyLabel="No users found."
      groupOptions={[]}
      label="Add members"
      onChange={(next) => onChange(next.userIds)}
      searchPlaceholder="Search users…"
      selectedGroupIds={[]}
      selectedUserIds={selectedUserIds}
      userOptions={userOptions}
    />
  );
}
