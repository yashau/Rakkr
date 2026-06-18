import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { roles, type ResourceGrant, type Role } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, type UserAccessUpdate } from "@/lib/api";

interface AccessDraft {
  grantsText: string;
  roles: Role[];
}

export function AccessPage() {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, AccessDraft>>({});
  const usersQuery = useQuery({
    queryFn: api.accessUsers,
    queryKey: ["access-users"],
  });
  const updateMutation = useMutation({
    mutationFn: ({ access, userId }: { access: UserAccessUpdate; userId: string }) =>
      api.updateUserAccess(userId, access),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-users"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
  const users = usersQuery.data?.data;

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
                <label className="grid gap-2 text-sm font-medium">
                  Scopes
                  <textarea
                    className="min-h-32 rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onChange={(event) =>
                      updateDraft(user.id, setDrafts, {
                        ...draft,
                        grantsText: event.target.value,
                      })
                    }
                    value={draft.grantsText}
                  />
                </label>
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
