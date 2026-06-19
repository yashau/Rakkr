import { Plus } from "lucide-react";
import { useState } from "react";
import type { AccessPolicyInput } from "@rakkr/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AccessPolicyEffect = AccessPolicyInput["effect"];
type AccessPolicySubjectType = AccessPolicyInput["subjectType"];

interface AccessPolicyDraft {
  effect: AccessPolicyEffect;
  reason: string;
  resourceId: string;
  resourceType: string;
  subjectId: string;
  subjectType: AccessPolicySubjectType;
}

const emptyPolicyDraft: AccessPolicyDraft = {
  effect: "deny",
  reason: "",
  resourceId: "",
  resourceType: "node",
  subjectId: "",
  subjectType: "everyone",
};
const policyEffects: AccessPolicyEffect[] = ["deny", "allow"];
const subjectTypes: AccessPolicySubjectType[] = ["everyone", "user", "group"];
const resourceTypes = [
  "site",
  "room",
  "node",
  "interface",
  "channel",
  "schedule",
  "recording",
  "alert",
  "*",
];

export function AccessPolicyComposer({ onAppend }: { onAppend: (line: string) => void }) {
  const [draft, setDraft] = useState<AccessPolicyDraft>(emptyPolicyDraft);
  const subjectIdRequired = draft.subjectType !== "everyone";
  const appendDisabled =
    !draft.resourceId.trim() ||
    !draft.resourceType.trim() ||
    (subjectIdRequired && !draft.subjectId.trim());

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="grid gap-1.5">
          <Label htmlFor="policy-effect">Effect</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            id="policy-effect"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                effect: event.target.value as AccessPolicyEffect,
              }))
            }
            value={draft.effect}
          >
            {policyEffects.map((effect) => (
              <option key={effect} value={effect}>
                {effect}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-subject-type">Subject</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            id="policy-subject-type"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                subjectId: event.target.value === "everyone" ? "" : current.subjectId,
                subjectType: event.target.value as AccessPolicySubjectType,
              }))
            }
            value={draft.subjectType}
          >
            {subjectTypes.map((subjectType) => (
              <option key={subjectType} value={subjectType}>
                {subjectType}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-subject-id">Subject ID</Label>
          <Input
            disabled={!subjectIdRequired}
            id="policy-subject-id"
            onChange={(event) =>
              setDraft((current) => ({ ...current, subjectId: event.target.value }))
            }
            value={draft.subjectId}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-resource-type">Resource</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            id="policy-resource-type"
            onChange={(event) =>
              setDraft((current) => ({ ...current, resourceType: event.target.value }))
            }
            value={draft.resourceType}
          >
            {resourceTypes.map((resourceType) => (
              <option key={resourceType} value={resourceType}>
                {resourceType}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-resource-id">Resource ID</Label>
          <Input
            id="policy-resource-id"
            onChange={(event) =>
              setDraft((current) => ({ ...current, resourceId: event.target.value }))
            }
            value={draft.resourceId}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-reason">Reason</Label>
          <Input
            id="policy-reason"
            onChange={(event) =>
              setDraft((current) => ({ ...current, reason: event.target.value }))
            }
            value={draft.reason}
          />
        </div>
      </div>
      <Button
        className="w-fit"
        disabled={appendDisabled}
        onClick={() => {
          onAppend(policyLine(draft));
          setDraft(emptyPolicyDraft);
        }}
        type="button"
        variant="outline"
      >
        <Plus className="size-4" />
        Add Policy
      </Button>
    </div>
  );
}

function policyLine(draft: AccessPolicyDraft) {
  const subject =
    draft.subjectType === "everyone"
      ? "everyone"
      : `${draft.subjectType}:${draft.subjectId.trim()}`;
  const resource = `${draft.resourceType.trim()}:${draft.resourceId.trim()}`;

  return [draft.effect, subject, resource, draft.reason.trim()].filter(Boolean).join(" | ");
}
