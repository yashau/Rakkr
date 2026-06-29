import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Pencil, Save, ShieldCheck, Trash2, UserCheck, UserX } from "lucide-react";
import type { CurrentUser } from "@rakkr/shared";
import { toast } from "sonner";

import { AccessCreateUserDialog } from "@/components/access-create-user-dialog";
import { AccessEditDialog } from "@/components/access-edit-dialog";
import { AccessResetPasswordDialog } from "@/components/access-reset-password-dialog";
import { AccessPolicyComposer } from "@/components/access-policy-composer";
import { ConfirmButton } from "@/components/confirm-button";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type UserAccessUpdate } from "@/lib/api";
import {
  accessPagePermissions,
  accessUpdateFromDraft,
  appendTextLine,
  createInputFromDraft,
  policiesFromText,
  policiesToText,
  type AccessDraft,
  type CreateUserDraft,
} from "@/lib/access-page-helpers";
import { defaultPageSize } from "@/lib/server-pagination";
import { useServerPagination } from "@/lib/use-server-pagination";

export function AccessPage() {
  const queryClient = useQueryClient();
  const [policyError, setPolicyError] = useState<string>();
  const [policiesText, setPoliciesText] = useState("");
  const [editUser, setEditUser] = useState<CurrentUser>();
  const [resetUser, setResetUser] = useState<CurrentUser>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const permissions = accessPagePermissions(currentUserQuery.data?.data);
  const userFilters = useMemo(() => ({}), []);
  const pagination = useServerPagination(userFilters, { defaultPageSize });
  const usersQuery = useQuery({
    enabled: permissions.canRead,
    placeholderData: keepPreviousData,
    queryFn: () => api.accessUsers(pagination.query),
    queryKey: ["access-users", pagination.query],
  });
  const groupsQuery = useQuery({
    enabled: permissions.canRead,
    queryFn: api.accessGroups,
    queryKey: ["access-groups"],
  });
  const policiesQuery = useQuery({
    enabled: permissions.canRead,
    queryFn: api.accessPolicies,
    queryKey: ["access-policies"],
  });
  const updateMutation = useMutation({
    mutationFn: ({ access, userId }: { access: UserAccessUpdate; userId: string }) =>
      api.updateUserAccess(userId, access),
    onError: () =>
      toast.error("Save failed", {
        description: "The user's access could not be updated.",
      }),
    onSuccess: () => {
      toast.success("Access updated");
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      setEditUser(undefined);
    },
  });
  const resetPasswordMutation = useMutation({
    mutationFn: ({ password, userId }: { password: string; userId: string }) =>
      api.resetUserPassword(userId, { password }),
    onError: () =>
      toast.error("Password reset failed", {
        description: "The user's password could not be reset.",
      }),
    onSuccess: () => {
      toast.success("Password reset");
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      setResetUser(undefined);
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ disabled, userId }: { disabled: boolean; userId: string }) =>
      api.updateUserStatus(userId, disabled),
    onError: () =>
      toast.error("Status update failed", {
        description: "The user's enabled status could not be changed.",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
  const deleteUserMutation = useMutation({
    mutationFn: api.deleteLocalUser,
    onError: () =>
      toast.error("Delete failed", {
        description: "The local user could not be deleted.",
      }),
    onSuccess: () => {
      toast.success("User deleted");
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
    },
  });
  const createUserMutation = useMutation({
    mutationFn: api.createLocalUser,
    onError: () =>
      toast.error("Create failed", {
        description: "The local user could not be created.",
      }),
    onSuccess: () => {
      toast.success("User created");
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
    },
  });
  const updatePoliciesMutation = useMutation({
    mutationFn: api.updateAccessPolicies,
    onError: () =>
      toast.error("Save failed", {
        description: "The access policies could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Policies saved");
      queryClient.invalidateQueries({ queryKey: ["access-policies"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      setPolicyError(undefined);
    },
  });
  const groups = groupsQuery.data?.data ?? [];

  useEffect(() => {
    if (policiesQuery.data) {
      setPoliciesText(policiesToText(policiesQuery.data.data));
    }
  }, [policiesQuery.data]);

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading access" />;
  }

  if (!permissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Access</AlertTitle>
        <AlertDescription>Access management is unavailable.</AlertDescription>
      </Alert>
    );
  }

  const users = usersQuery.data?.data ?? [];
  const meta = usersQuery.data?.meta;
  const selfId = currentUserQuery.data?.data.id;
  const columns = accessUserColumns({
    canManage: permissions.canManage,
    onDelete: (userId) => deleteUserMutation.mutate(userId),
    onEdit: (user) => setEditUser(user),
    onResetPassword: (user) => setResetUser(user),
    onToggleStatus: (userId, disabled) => statusMutation.mutate({ disabled, userId }),
    pending: {
      delete: deleteUserMutation.isPending,
      status: statusMutation.isPending,
    },
    selfId,
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-teal-700" />
          <div>
            <h2 className="text-lg font-semibold">Access</h2>
            <p className="text-sm text-muted-foreground">{meta?.total ?? users.length} users</p>
          </div>
        </div>
        {permissions.canManage ? (
          <AccessCreateUserDialog
            onSubmit={submitCreateUser}
            saving={createUserMutation.isPending}
          />
        ) : null}
      </div>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={users}
          emptyMessage="No users found."
          getRowId={(user) => user.id}
          isLoading={usersQuery.isPending}
        />
        <DataTablePagination
          meta={meta}
          onNext={pagination.nextPage}
          onPageSizeChange={pagination.setPageSize}
          onPrevious={pagination.previousPage}
          pageSize={pagination.pageSize}
          pageSizes={pagination.pageSizes}
        />
      </section>

      {permissions.canManage ? (
        <Card className="rounded-lg p-4 shadow-sm">
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = policiesFromText(policiesText);

              if (parsed.error) {
                setPolicyError(parsed.error);
                return;
              }

              updatePoliciesMutation.mutate(parsed.policies);
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="access-policies">Access Policies</Label>
              <Textarea
                className="min-h-32 bg-background font-mono text-xs"
                id="access-policies"
                onChange={(event) => {
                  setPoliciesText(event.target.value);
                  setPolicyError(undefined);
                }}
                placeholder="deny | everyone | node:node_x32_test"
                value={policiesText}
              />
            </div>
            <AccessPolicyComposer
              onAppend={(line) => {
                setPoliciesText((current) => appendTextLine(current, line));
                setPolicyError(undefined);
              }}
            />
            {policyError ? <p className="text-sm text-red-700">{policyError}</p> : null}
            {groups.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {groups.map((group) => (
                  <Badge className="bg-background" key={group.id} variant="outline">
                    {group.name}
                  </Badge>
                ))}
              </div>
            ) : null}
            <Button disabled={updatePoliciesMutation.isPending} type="submit">
              <Save className="size-4" />
              Save Policies
            </Button>
          </form>
        </Card>
      ) : null}

      {permissions.canManage ? (
        <>
          <AccessEditDialog
            onOpenChange={(open) => (open ? undefined : setEditUser(undefined))}
            onSubmit={submitAccessUpdate}
            open={Boolean(editUser)}
            saving={updateMutation.isPending}
            user={editUser}
          />
          <AccessResetPasswordDialog
            onOpenChange={(open) => (open ? undefined : setResetUser(undefined))}
            onSubmit={(userId, password) => resetPasswordMutation.mutate({ password, userId })}
            open={Boolean(resetUser)}
            saving={resetPasswordMutation.isPending}
            user={resetUser}
          />
        </>
      ) : null}
    </div>
  );

  function submitCreateUser(draft: CreateUserDraft) {
    createUserMutation.mutate(createInputFromDraft(draft));
  }

  function submitAccessUpdate(userId: string, draft: AccessDraft) {
    updateMutation.mutate({ access: accessUpdateFromDraft(draft), userId });
  }
}

interface AccessUserColumnOptions {
  canManage: boolean;
  onDelete: (userId: string) => void;
  onEdit: (user: CurrentUser) => void;
  onResetPassword: (user: CurrentUser) => void;
  onToggleStatus: (userId: string, disabled: boolean) => void;
  pending: {
    delete: boolean;
    status: boolean;
  };
  selfId: string | undefined;
}

function accessUserColumns({
  canManage,
  onDelete,
  onEdit,
  onResetPassword,
  onToggleStatus,
  pending,
  selfId,
}: AccessUserColumnOptions): ColumnDef<CurrentUser>[] {
  const columns: ColumnDef<CurrentUser>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium">{row.original.name}</div>
          {row.original.id === selfId ? (
            <Badge className="mt-1 bg-background" variant="outline">
              you
            </Badge>
          ) : null}
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">{row.original.email}</span>
      ),
      header: "Email",
      id: "email",
    },
    {
      cell: ({ row }) => <Badge variant="secondary">{row.original.provider}</Badge>,
      header: "Provider",
      id: "provider",
    },
    {
      cell: ({ row }) =>
        row.original.roles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.original.roles.map((role) => (
              <Badge className="bg-background" key={role} variant="outline">
                {role}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">none</span>
        ),
      header: "Roles",
      id: "roles",
    },
    {
      cell: ({ row }) =>
        row.original.groups.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.original.groups.map((group) => (
              <Badge className="bg-background" key={group.id} variant="outline">
                {group.name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">none</span>
        ),
      header: "Groups",
      id: "groups",
    },
    {
      cell: ({ row }) => (
        <Badge variant={row.original.disabledAt ? "outline" : "secondary"}>
          {row.original.disabledAt ? "disabled" : "enabled"}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
  ];

  if (canManage) {
    columns.push({
      cell: ({ row }) => {
        const user = row.original;
        const isSelf = user.id === selfId;

        return (
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => onEdit(user)} size="sm" type="button" variant="outline">
              <Pencil className="size-4" />
              Edit access
            </Button>
            <Button onClick={() => onResetPassword(user)} size="sm" type="button" variant="outline">
              <KeyRound className="size-4" />
              Reset password
            </Button>
            <Button
              disabled={pending.status || (isSelf && !user.disabledAt)}
              onClick={() => onToggleStatus(user.id, !user.disabledAt)}
              size="sm"
              type="button"
              variant="outline"
            >
              {user.disabledAt ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
              {user.disabledAt ? "Enable" : "Disable"}
            </Button>
            <ConfirmButton
              confirmLabel="Delete"
              description={`This permanently deletes the local user "${user.name}".`}
              disabled={pending.delete || isSelf}
              onConfirm={() => onDelete(user.id)}
              size="sm"
              title={`Delete user "${user.name}"?`}
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
