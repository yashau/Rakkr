import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  roles,
  type AccessPolicy,
  type AccessPolicyInput,
  type ResourceGrant,
  type Role,
} from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type UserAccessUpdate } from "@/lib/api";

interface AccessDraft {
  grantsText: string;
  roles: Role[];
}

export function AccessPage() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, AccessDraft>>({});
  const [policyError, setPolicyError] = useState<string>();
  const [policiesText, setPoliciesText] = useState("");
  const usersQuery = useQuery({
    queryFn: api.accessUsers,
    queryKey: ["access-users"],
  });
  const policiesQuery = useQuery({
    queryFn: api.accessPolicies,
    queryKey: ["access-policies"],
  });
  const updateMutation = useMutation({
    mutationFn: ({ access, userId }: { access: UserAccessUpdate; userId: string }) =>
      api.updateUserAccess(userId, access),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
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
          {policyError ? <p className="text-sm text-red-700">{policyError}</p> : null}
          <Button disabled={updatePoliciesMutation.isPending} type="submit">
            <Save className="size-4" />
            Save Policies
          </Button>
        </form>
      </Card>

      {(users ?? []).map((user) => {
        const draft = drafts[user.id] ?? {
          grantsText: grantsToText(user.resourceGrants),
          roles: user.roles,
        };

        return (
          <Card className="rounded-lg p-4 shadow-sm" key={user.id}>
            <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
              <div className="min-w-0">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{user.name}</h3>
                  <Badge variant="secondary">{user.provider}</Badge>
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
                  {roles.map((role) => (
                    <label
                      className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm"
                      key={role}
                    >
                      <input
                        checked={draft.roles.includes(role)}
                        onChange={(event) =>
                          updateDraft(user.id, setDrafts, {
                            ...draft,
                            roles: event.target.checked
                              ? [...draft.roles, role]
                              : draft.roles.filter((value) => value !== role),
                          })
                        }
                        type="checkbox"
                      />
                      {role}
                    </label>
                  ))}
                </div>
              </div>

              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  updateMutation.mutate({
                    access: {
                      resourceGrants: grantsFromText(draft.grantsText),
                      roles: draft.roles.length > 0 ? draft.roles : ["viewer"],
                    },
                    userId: user.id,
                  });
                }}
              >
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
              </form>
            </div>
          </Card>
        );
      })}
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
