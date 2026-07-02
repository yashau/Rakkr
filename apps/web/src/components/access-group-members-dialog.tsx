import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import type { AccessGroupSummary } from "@rakkr/shared";

import type { AssigneeOption } from "@/components/assignee-multi-select";
import { UserMultiSelect } from "@/components/user-multi-select";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

// Membership editor for a single access group. Loads the group's current members on
// open (the list endpoint only carries counts), then replaces the whole set on save.
export function AccessGroupMembersDialog({
  group,
  onOpenChange,
  onSubmit,
  open,
  saving,
  userOptions,
}: {
  group: AccessGroupSummary | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (groupId: string, memberIds: string[]) => void;
  open: boolean;
  saving: boolean;
  userOptions: AssigneeOption[];
}) {
  const groupId = group?.id;
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const detailQuery = useQuery({
    enabled: open && Boolean(groupId),
    queryFn: () => api.accessGroup(groupId ?? ""),
    queryKey: ["access-group", groupId],
  });

  useEffect(() => {
    if (open && detailQuery.data) {
      setMemberIds(detailQuery.data.data.group.members.map((member) => member.id));
    }
  }, [detailQuery.data, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{group ? `Members — ${group.name}` : "Members"}</DialogTitle>
          <DialogDescription>
            Choose which users belong to this group. Group membership confers the group's scoped
            access to its members.
          </DialogDescription>
        </DialogHeader>
        {detailQuery.isPending && open ? (
          <LoadingSkeleton label="Loading members" />
        ) : (
          <div className="grid gap-2">
            <UserMultiSelect
              onChange={setMemberIds}
              selectedUserIds={memberIds}
              userOptions={userOptions}
            />
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || !group || detailQuery.isPending}
            onClick={() => group && onSubmit(group.id, memberIds)}
            type="button"
          >
            <Save className="size-4" />
            Save members
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
