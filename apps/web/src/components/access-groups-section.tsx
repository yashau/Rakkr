import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2, Users, UsersRound } from "lucide-react";
import type {
  AccessGroupCreateRequest,
  AccessGroupSummary,
  AccessGroupUpdateRequest,
} from "@rakkr/shared";
import { toast } from "sonner";

import { AccessGroupFormDialog } from "@/components/access-group-form-dialog";
import { AccessGroupMembersDialog } from "@/components/access-group-members-dialog";
import type { AssigneeOption } from "@/components/assignee-multi-select";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { api } from "@/lib/api";

// Group management lives as a section of the Access page. Deleting a group cascades:
// the controller strips it from policies, rosters, and schedule assignments, so this
// invalidates those caches too.
export function AccessGroupsSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [formGroup, setFormGroup] = useState<AccessGroupSummary>();
  const [membersGroup, setMembersGroup] = useState<AccessGroupSummary>();
  const groupsQuery = useQuery({
    queryFn: () => api.accessGroups({ limit: 200 }),
    queryKey: ["access-groups"],
  });
  const usersQuery = useQuery({
    queryFn: () => api.accessUsers({ limit: 200 }),
    queryKey: ["access-users", { limit: 200 }],
  });
  const userOptions = useMemo<AssigneeOption[]>(
    () =>
      (usersQuery.data?.data ?? []).map((user) => ({
        id: user.id,
        label: user.name,
        sublabel: user.email,
      })),
    [usersQuery.data],
  );

  function invalidateGroups() {
    queryClient.invalidateQueries({ queryKey: ["access-groups"] });
  }

  function invalidateMembershipCaches(groupId: string) {
    invalidateGroups();
    queryClient.invalidateQueries({ queryKey: ["access-group", groupId] });
    queryClient.invalidateQueries({ queryKey: ["access-users"] });
    queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  const createMutation = useMutation({
    mutationFn: (input: AccessGroupCreateRequest) => api.createAccessGroup(input),
    onError: () =>
      toast.error("Create failed", { description: "The access group could not be created." }),
    onSuccess: (result) => {
      toast.success("Group created");
      invalidateMembershipCaches(result.data.id);
      setFormOpen(false);
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ groupId, input }: { groupId: string; input: AccessGroupUpdateRequest }) =>
      api.updateAccessGroup(groupId, input),
    onError: () =>
      toast.error("Save failed", { description: "The access group could not be updated." }),
    onSuccess: (result) => {
      toast.success("Group updated");
      invalidateMembershipCaches(result.data.id);
      setFormOpen(false);
    },
  });
  const membersMutation = useMutation({
    mutationFn: ({ groupId, memberIds }: { groupId: string; memberIds: string[] }) =>
      api.updateAccessGroupMembers(groupId, { memberIds }),
    onError: () =>
      toast.error("Save failed", { description: "The group's members could not be updated." }),
    onSuccess: (result) => {
      toast.success("Members updated");
      invalidateMembershipCaches(result.data.id);
      setMembersGroup(undefined);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => api.deleteAccessGroup(groupId),
    onError: () =>
      toast.error("Delete failed", { description: "The access group could not be deleted." }),
    onSuccess: () => {
      toast.success("Group deleted");
      invalidateGroups();
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      queryClient.invalidateQueries({ queryKey: ["access-policies"] });
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      queryClient.invalidateQueries({ queryKey: ["room-roster"] });
    },
  });

  const groups = groupsQuery.data?.data ?? [];
  const columns = accessGroupColumns({
    canManage,
    onDelete: (groupId) => deleteMutation.mutate(groupId),
    onEdit: (group) => {
      setFormGroup(group);
      setFormOpen(true);
    },
    onMembers: (group) => setMembersGroup(group),
    pending: deleteMutation.isPending,
  });

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Access Groups</h3>
            <p className="text-xs text-muted-foreground">
              {groups.length} group{groups.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        {canManage ? (
          <Button
            onClick={() => {
              setFormGroup(undefined);
              setFormOpen(true);
            }}
            size="sm"
            type="button"
          >
            <Plus className="size-4" />
            Add group
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={groups}
        emptyMessage="No access groups yet."
        getRowId={(group) => group.id}
        isLoading={groupsQuery.isPending}
      />

      {canManage ? (
        <>
          <AccessGroupFormDialog
            group={formGroup}
            onOpenChange={(open) => (open ? undefined : setFormOpen(false))}
            onSubmitCreate={(input) => createMutation.mutate(input)}
            onSubmitUpdate={(groupId, input) => updateMutation.mutate({ groupId, input })}
            open={formOpen}
            saving={createMutation.isPending || updateMutation.isPending}
            userOptions={userOptions}
          />
          <AccessGroupMembersDialog
            group={membersGroup}
            onOpenChange={(open) => (open ? undefined : setMembersGroup(undefined))}
            onSubmit={(groupId, memberIds) => membersMutation.mutate({ groupId, memberIds })}
            open={Boolean(membersGroup)}
            saving={membersMutation.isPending}
            userOptions={userOptions}
          />
        </>
      ) : null}
    </Card>
  );
}

interface AccessGroupColumnOptions {
  canManage: boolean;
  onDelete: (groupId: string) => void;
  onEdit: (group: AccessGroupSummary) => void;
  onMembers: (group: AccessGroupSummary) => void;
  pending: boolean;
}

function accessGroupColumns({
  canManage,
  onDelete,
  onEdit,
  onMembers,
  pending,
}: AccessGroupColumnOptions): ColumnDef<AccessGroupSummary>[] {
  const columns: ColumnDef<AccessGroupSummary>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{row.original.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-sm text-muted-foreground">{row.original.description}</span>
        ) : (
          <span className="text-xs text-muted-foreground">none</span>
        ),
      header: "Description",
      id: "description",
    },
    {
      cell: ({ row }) => (
        <Badge className="bg-transparent" variant="outline">
          {row.original.memberCount} member{row.original.memberCount === 1 ? "" : "s"}
        </Badge>
      ),
      header: "Members",
      id: "members",
    },
  ];

  if (canManage) {
    columns.push({
      cell: ({ row }) => {
        const group = row.original;

        return (
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => onEdit(group)} size="sm" type="button" variant="outline">
              <Pencil className="size-4" />
              Edit
            </Button>
            <Button onClick={() => onMembers(group)} size="sm" type="button" variant="outline">
              <UsersRound className="size-4" />
              Members
            </Button>
            <ConfirmButton
              confirmLabel="Delete"
              description={`This deletes the group "${group.name}" and removes it from all access policies, room rosters, and schedule assignments.`}
              disabled={pending}
              onConfirm={() => onDelete(group.id)}
              size="sm"
              title={`Delete group "${group.name}"?`}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </ConfirmButton>
          </div>
        );
      },
      header: () => <span className="sr-only">Actions</span>,
      id: "actions",
      meta: { cellClassName: "text-right", headClassName: "text-right" },
    });
  }

  return columns;
}
