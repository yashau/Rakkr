import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ResourceGrantDraft {
  resourceId: string;
  resourceType: string;
}

const emptyGrantDraft: ResourceGrantDraft = {
  resourceId: "",
  resourceType: "node",
};
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

export function ResourceGrantComposer({ onAppend }: { onAppend: (line: string) => void }) {
  const [draft, setDraft] = useState<ResourceGrantDraft>(emptyGrantDraft);
  const appendDisabled = !draft.resourceId.trim() || !draft.resourceType.trim();

  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-2">
      <div className="grid gap-2 sm:grid-cols-[120px_1fr_auto]">
        <div className="grid gap-1.5">
          <Label htmlFor="scope-resource-type">Resource</Label>
          <Select
            onValueChange={(value) => setDraft((current) => ({ ...current, resourceType: value }))}
            value={draft.resourceType}
          >
            <SelectTrigger
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              id="scope-resource-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {resourceTypes.map((resourceType) => (
                <SelectItem key={resourceType} value={resourceType}>
                  {resourceType}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="scope-resource-id">Resource ID</Label>
          <Input
            id="scope-resource-id"
            onChange={(event) =>
              setDraft((current) => ({ ...current, resourceId: event.target.value }))
            }
            value={draft.resourceId}
          />
        </div>
        <Button
          className="self-end"
          disabled={appendDisabled}
          onClick={() => {
            onAppend(`${draft.resourceType.trim()}:${draft.resourceId.trim()}`);
            setDraft(emptyGrantDraft);
          }}
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          Add Scope
        </Button>
      </div>
    </div>
  );
}
