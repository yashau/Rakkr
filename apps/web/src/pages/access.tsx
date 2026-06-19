import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Save, ShieldCheck, Trash2, UserCheck, UserPlus, UserX } from "lucide-react";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  roles,
  type AccessGroup,
  type AccessPolicy,
  type AccessPolicyInput,
  type ResourceGrant,
  type Role,
} from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type LocalUserCreateInput, type UserAccessUpdate } from "@/lib/api";
import { AccessPolicyComposer } from "@/components/access-policy-composer";

interface AccessDraft {
  groupsText: string;
  grantsText: string;
  roles: Role[];
}

interface CreateUserDraft {
  email: string;
  groupsText: string;
  grantsText: string;
  name: string;
  password: string;
  roles: Role[];
}

const emptyCreateUserDraft: CreateUserDraft = {
  email: "",
  groupsText: "",
  grantsText: "",
  name: "",
  password: "",
  roles: ["viewer"],
};

export function AccessPage() {
  const queryClient = useQueryClient();
  const [createDraft, setCreateDraft] = useState<CreateUserDraft>(emptyCreateUserDraft);
  const [drafts, setDrafts] = useState<Record<string, AccessDraft>>({});
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [policyError, setPolicyError] = useState<string>();
  const [policiesText, setPoliciesText] = useState("");
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const usersQuery = useQuery({
    queryFn: api.accessUsers,
    queryKey: ["access-users"],
  });
  const groupsQuery = useQuery({
    queryFn: api.accessGroups,
    queryKey: ["access-groups"],
  });
  const policiesQuery = useQuery({
    queryFn: api.accessPolicies,
    queryKey: ["access-policies"],
  });
  const updateMutation = useMutation({
    mutationFn: ({ access, userId }: { access: UserAccessUpdate; userId: string }) =>
      api.updateUserAccess(userId, access),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
  const resetPasswordMutation = useMutation({
    mutationFn: ({ password, userId }: { password: string; userId: string }) =>
      api.resetUserPassword(userId, { password }),
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      setPasswordDrafts((current) => ({ ...current, [input.userId]: "" }));
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ disabled, userId }: { disabled: boolean; userId: string }) =>
      api.updateUserStatus(userId, disabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
  const deleteUserMutation = useMutation({
    mutationFn: api.deleteLocalUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
    },
  });
  const createUserMutation = useMutation({
    mutationFn: api.createLocalUser,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-groups"] });
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      setCreateDraft(emptyCreateUserDraft);
    },
  });
  const updatePoliciesMutation = useMutation({
    mutationFn: api.updateAccessPolicies,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-policies"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      setPolicyError(undefined);
    },
  });
  const users = usersQuery.data?.data;
  const groups = groupsQuery.data?.data ?? [];

  useEffect(() => {
    if (policiesQuery.data) {
      setPoliciesText(policiesToText(policiesQuery.data.data));
    }
  }, [policiesQuery.data]);

  useEffect(() => {
    if (!users) {
      return;
    }

    setDrafts((current) => {
      const next = { ...current };

      for (const user of users) {
        next[user.id] ??= {
          groupsText: groupsToText(user.groups),
          grantsText: grantsToText(user.resourceGrants),
          roles: user.roles,
        };
      }

      return next;
    });
  }, [users]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-teal-700" />
        <h2 className="text-base font-semibold">Access</h2>
      </div>

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
              setPoliciesText((current) => appendPolicyLine(current, line));
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

      <Card className="rounded-lg p-4 shadow-sm">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            createUserMutation.mutate(createInputFromDraft(createDraft));
          }}
        >
          <div className="flex items-center gap-2">
            <UserPlus className="size-4 text-teal-700" />
            <h3 className="text-sm font-semibold">Local User</h3>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="new-user-email">Email</Label>
              <Input
                id="new-user-email"
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, email: event.target.value }))
                }
                type="email"
                value={createDraft.email}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-user-name">Name</Label>
              <Input
                id="new-user-name"
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, name: event.target.value }))
                }
                value={createDraft.name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-user-password">Password</Label>
              <Input
                id="new-user-password"
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, password: event.target.value }))
                }
                type="password"
                value={createDraft.password}
              />
            </div>
          </div>
          <RolePicker
            rolesValue={createDraft.roles}
            onChange={(nextRoles) =>
              setCreateDraft((current) => ({
                ...current,
                roles: nextRoles,
              }))
            }
          />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-user-groups">Groups</Label>
              <Textarea
                className="min-h-20 bg-background font-mono text-xs"
                id="new-user-groups"
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, groupsText: event.target.value }))
                }
                placeholder="operators"
                value={createDraft.groupsText}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-user-scopes">Scopes</Label>
              <Textarea
                className="min-h-20 bg-background font-mono text-xs"
                id="new-user-scopes"
                onChange={(event) =>
                  setCreateDraft((current) => ({ ...current, grantsText: event.target.value }))
                }
                placeholder="node:node_x32_test"
                value={createDraft.grantsText}
              />
            </div>
          </div>
          <Button
            disabled={
              createUserMutation.isPending ||
              !createDraft.email.trim() ||
              !createDraft.name.trim() ||
              createDraft.password.length < 8
            }
            type="submit"
          >
            <UserPlus className="size-4" />
            Create
          </Button>
        </form>
      </Card>

      {(users ?? []).map((user) => {
        const draft = drafts[user.id] ?? {
          groupsText: groupsToText(user.groups),
          grantsText: grantsToText(user.resourceGrants),
          roles: user.roles,
        };
        const passwordDraft = passwordDrafts[user.id] ?? "";
        const isSelf = user.id === currentUserQuery.data?.data.id;

        return (
          <Card className="rounded-lg p-4 shadow-sm" key={user.id}>
            <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{user.name}</h3>
                  <Badge variant="secondary">{user.provider}</Badge>
                  {user.disabledAt ? <Badge variant="outline">disabled</Badge> : null}
                </div>
                <div className="font-mono text-xs text-muted-foreground">{user.email}</div>
                {user.groups.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {user.groups.map((group) => (
                      <Badge className="bg-background" key={group.id} variant="outline">
                        {group.name}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <RolePicker
                    rolesValue={draft.roles}
                    onChange={(nextRoles) =>
                      updateDraft(user.id, setDrafts, {
                        ...draft,
                        roles: nextRoles,
                      })
                    }
                  />
                </div>
              </div>

              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  updateMutation.mutate({
                    access: {
                      groupIds: groupIdsFromText(draft.groupsText),
                      resourceGrants: grantsFromText(draft.grantsText),
                      roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
                    },
                    userId: user.id,
                  });
                }}
              >
                <div className="grid gap-2">
                  <Label htmlFor={`${user.id}-groups`}>Groups</Label>
                  <Textarea
                    className="min-h-20 bg-background font-mono text-xs"
                    id={`${user.id}-groups`}
                    onChange={(event) =>
                      updateDraft(user.id, setDrafts, {
                        ...draft,
                        groupsText: event.target.value,
                      })
                    }
                    placeholder="operators"
                    value={draft.groupsText}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`${user.id}-scopes`}>Scopes</Label>
                  <Textarea
                    id={`${user.id}-scopes`}
                    className="min-h-32 bg-background font-mono text-xs"
                    onChange={(event) =>
                      updateDraft(user.id, setDrafts, {
                        ...draft,
                        grantsText: event.target.value,
                      })
                    }
                    value={draft.grantsText}
                  />
                </div>
                <Button disabled={updateMutation.isPending} type="submit">
                  <Save className="size-4" />
                  Save
                </Button>
                <div className="grid gap-2 border-t pt-3">
                  <Label htmlFor={`${user.id}-password`}>Reset Password</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id={`${user.id}-password`}
                      onChange={(event) =>
                        setPasswordDrafts((current) => ({
                          ...current,
                          [user.id]: event.target.value,
                        }))
                      }
                      type="password"
                      value={passwordDraft}
                    />
                    <Button
                      disabled={resetPasswordMutation.isPending || passwordDraft.length < 8}
                      onClick={() =>
                        resetPasswordMutation.mutate({
                          password: passwordDraft,
                          userId: user.id,
                        })
                      }
                      type="button"
                      variant="outline"
                    >
                      <KeyRound className="size-4" />
                      Reset
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={statusMutation.isPending || (isSelf && !user.disabledAt)}
                      onClick={() =>
                        statusMutation.mutate({
                          disabled: !user.disabledAt,
                          userId: user.id,
                        })
                      }
                      type="button"
                      variant="outline"
                    >
                      {user.disabledAt ? (
                        <UserCheck className="size-4" />
                      ) : (
                        <UserX className="size-4" />
                      )}
                      {user.disabledAt ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      disabled={deleteUserMutation.isPending || isSelf}
                      onClick={() => deleteUserMutation.mutate(user.id)}
                      type="button"
                      variant="outline"
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </Card>
        );
      })}
      {resetPasswordMutation.isError ? (
        <p className="text-sm text-destructive">Password reset failed.</p>
      ) : null}
      {statusMutation.isError ? (
        <p className="text-sm text-destructive">User status update failed.</p>
      ) : null}
      {deleteUserMutation.isError ? (
        <p className="text-sm text-destructive">User delete failed.</p>
      ) : null}
    </div>
  );
}

function RolePicker({
  onChange,
  rolesValue,
}: {
  onChange: (rolesValue: Role[]) => void;
  rolesValue: Role[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((role) => (
        <label
          className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm"
          key={role}
        >
          <input
            checked={rolesValue.includes(role)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...rolesValue, role]
                  : rolesValue.filter((value) => value !== role),
              )
            }
            type="checkbox"
          />
          {role}
        </label>
      ))}
    </div>
  );
}

function policiesToText(policies: AccessPolicy[]) {
  return policies
    .map((policy) =>
      [
        policy.effect,
        policySubject(policy),
        `${policy.resourceType}:${policy.resourceId}`,
        policy.reason,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

function appendPolicyLine(current: string, line: string) {
  const trimmed = current.trim();

  return trimmed ? `${trimmed}\n${line}` : line;
}

function policySubject(policy: AccessPolicy) {
  if (policy.subjectType === "everyone") {
    return "everyone";
  }

  return `${policy.subjectType}:${policy.subjectId ?? ""}`;
}

function policiesFromText(value: string): { error?: string; policies: AccessPolicyInput[] } {
  const policies: AccessPolicyInput[] = [];
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    const parts = line.includes("|")
      ? line.split("|").map((part) => part.trim())
      : line.split(/\s+/);
    const [effect, subject, resource, ...reasonParts] = parts;

    if (effect !== "allow" && effect !== "deny") {
      return { error: `Line ${index + 1} must start with allow or deny.`, policies: [] };
    }

    const parsedSubject = subjectFromText(subject);
    const parsedResource = resourceFromText(resource);

    if (!parsedSubject || !parsedResource) {
      return { error: `Line ${index + 1} has an invalid subject or resource.`, policies: [] };
    }

    policies.push({
      effect,
      reason: reasonParts.join(" | ") || undefined,
      resourceId: parsedResource.resourceId,
      resourceType: parsedResource.resourceType,
      subjectId: parsedSubject.subjectId,
      subjectType: parsedSubject.subjectType,
    });
  }

  return { policies };
}

function subjectFromText(
  value: string | undefined,
): Pick<AccessPolicyInput, "subjectId" | "subjectType"> | undefined {
  if (value === "everyone") {
    return {
      subjectType: "everyone" as const,
    };
  }

  const parsed = typedToken(value);

  if (!parsed || (parsed.type !== "user" && parsed.type !== "group")) {
    return undefined;
  }

  return {
    subjectId: parsed.id,
    subjectType: parsed.type === "user" ? "user" : "group",
  };
}

function resourceFromText(value: string | undefined) {
  const parsed = typedToken(value);

  return parsed
    ? {
        resourceId: parsed.id,
        resourceType: parsed.type,
      }
    : undefined;
}

function typedToken(value: string | undefined) {
  const separator = value?.indexOf(":") ?? -1;

  if (!value || separator <= 0) {
    return undefined;
  }

  const type = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();

  return type && id
    ? {
        id,
        type,
      }
    : undefined;
}

function updateDraft(
  userId: string,
  setDrafts: Dispatch<SetStateAction<Record<string, AccessDraft>>>,
  draft: AccessDraft,
) {
  setDrafts((current) => ({
    ...current,
    [userId]: draft,
  }));
}

function grantsToText(grants: ResourceGrant[]) {
  return grants.map((grant) => `${grant.resourceType}:${grant.resourceId}`).join("\n");
}

function groupsToText(groups: AccessGroup[]) {
  return groups.map((group) => group.id).join("\n");
}

function groupIdsFromText(value: string) {
  return uniqueTextValues(value);
}

function createInputFromDraft(draft: CreateUserDraft): LocalUserCreateInput {
  return {
    email: draft.email.trim(),
    groupIds: groupIdsFromText(draft.groupsText),
    name: draft.name.trim(),
    password: draft.password,
    resourceGrants: grantsFromText(draft.grantsText),
    roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
  };
}

function grantsFromText(value: string): ResourceGrant[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");

      return separator === -1
        ? {
            resourceId: line,
            resourceType: "node",
          }
        : {
            resourceId: line.slice(separator + 1).trim(),
            resourceType: line.slice(0, separator).trim(),
          };
    })
    .filter((grant) => grant.resourceId && grant.resourceType);
}

function uniqueTextValues(value: string) {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
