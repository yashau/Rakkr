import { CheckSquare, Download, RotateCcw, Trash2, UploadCloud, X } from "lucide-react";
import { useState } from "react";
import type { UploadPolicy } from "@rakkr/shared";

import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
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
import type { RecordingBulkMetadataUpdate } from "@/lib/api";

interface BulkDraft {
  addTags: string;
  folder: string;
  removeTags: string;
  replaceTags: string;
}

const emptyBulkDraft: BulkDraft = {
  addTags: "",
  folder: "",
  removeTags: "",
  replaceTags: "",
};

export function RecordingBulkOrganizer({
  allVisibleSelected,
  canDelete,
  canEdit,
  canExport,
  canUpload,
  deleteDisabled,
  deleteEligibleCount,
  disabled,
  exportDisabled,
  onApply,
  onClear,
  onDeleteSelected,
  onExportSelected,
  onSelectVisible,
  onUploadSelected,
  selectedCount,
  uploadDisabled,
  uploadEligibleCount,
  uploadPolicies,
  visibleCount,
}: {
  allVisibleSelected: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canExport: boolean;
  canUpload: boolean;
  deleteDisabled: boolean;
  deleteEligibleCount: number;
  disabled: boolean;
  exportDisabled: boolean;
  onApply: (input: Omit<RecordingBulkMetadataUpdate, "recordingIds">) => void;
  onClear: () => void;
  onDeleteSelected: () => void;
  onExportSelected: () => void;
  onSelectVisible: () => void;
  onUploadSelected: (uploadPolicyId?: string) => void;
  selectedCount: number;
  uploadDisabled: boolean;
  uploadEligibleCount: number;
  uploadPolicies: UploadPolicy[];
  visibleCount: number;
}) {
  const [draft, setDraft] = useState(emptyBulkDraft);
  const [selectedUploadPolicyId, setSelectedUploadPolicyId] = useState(uploadPolicies[0]?.id ?? "");
  const input = bulkInputFromDraft(draft);
  const applyDisabled = disabled || selectedCount === 0 || Object.keys(input).length === 0;
  const bulkDeleteDisabled = deleteDisabled || selectedCount === 0 || deleteEligibleCount === 0;
  const bulkExportDisabled = exportDisabled || selectedCount === 0;
  const bulkUploadDisabled = uploadDisabled || selectedCount === 0 || uploadEligibleCount === 0;
  const uploadPolicyId = selectedUploadPolicyId || uploadPolicies[0]?.id;

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Bulk organize</h3>
          <Badge variant="secondary">{selectedCount} selected</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={visibleCount === 0 || allVisibleSelected}
            onClick={onSelectVisible}
            type="button"
            variant="outline"
          >
            <CheckSquare className="size-4" />
            Select visible
          </Button>
          <Button disabled={selectedCount === 0} onClick={onClear} type="button" variant="outline">
            <X className="size-4" />
            Clear
          </Button>
          {canExport ? (
            <Button
              disabled={bulkExportDisabled}
              onClick={onExportSelected}
              type="button"
              variant="outline"
            >
              <Download className="size-4" />
              Export selected
            </Button>
          ) : null}
        </div>
      </div>
      {canEdit ? (
        <form
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            onApply(input);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="recording-bulk-folder">Folder</Label>
            <Input
              id="recording-bulk-folder"
              onChange={(event) =>
                setDraft((current) => ({ ...current, folder: event.target.value }))
              }
              value={draft.folder}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-bulk-add-tags">Add Tags</Label>
            <Input
              id="recording-bulk-add-tags"
              onChange={(event) =>
                setDraft((current) => ({ ...current, addTags: event.target.value }))
              }
              value={draft.addTags}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-bulk-remove-tags">Remove Tags</Label>
            <Input
              id="recording-bulk-remove-tags"
              onChange={(event) =>
                setDraft((current) => ({ ...current, removeTags: event.target.value }))
              }
              value={draft.removeTags}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-bulk-replace-tags">Replace Tags</Label>
            <Input
              id="recording-bulk-replace-tags"
              onChange={(event) =>
                setDraft((current) => ({ ...current, replaceTags: event.target.value }))
              }
              value={draft.replaceTags}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2 xl:col-span-4">
            <Button disabled={applyDisabled} type="submit">
              <CheckSquare className="size-4" />
              Apply
            </Button>
            <Button onClick={() => setDraft(emptyBulkDraft)} type="button" variant="outline">
              <RotateCcw className="size-4" />
              Reset
            </Button>
          </div>
        </form>
      ) : null}
      {canDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{deleteEligibleCount} deletable</Badge>
          <ConfirmButton
            confirmLabel="Delete"
            description="This permanently deletes the selected terminal recordings and their cached files."
            disabled={bulkDeleteDisabled}
            onConfirm={onDeleteSelected}
            title={`Delete ${deleteEligibleCount} selected recording${
              deleteEligibleCount === 1 ? "" : "s"
            }?`}
            variant="destructive"
          >
            <Trash2 className="size-4" />
            Delete selected
          </ConfirmButton>
        </div>
      ) : null}
      {canUpload ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{uploadEligibleCount} cached</Badge>
          {uploadPolicies.length > 0 ? (
            <Select
              onValueChange={(value) => setSelectedUploadPolicyId(value)}
              value={uploadPolicyId ?? ""}
            >
              <SelectTrigger className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {uploadPolicies.map((policy) => (
                  <SelectItem key={policy.id} value={policy.id}>
                    {policy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            disabled={bulkUploadDisabled}
            onClick={() => onUploadSelected(uploadPolicyId)}
            type="button"
            variant="outline"
          >
            <UploadCloud className="size-4" />
            Queue upload
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function bulkInputFromDraft(draft: BulkDraft): Omit<RecordingBulkMetadataUpdate, "recordingIds"> {
  const folder = textOrUndefined(draft.folder);
  const replaceTags = tagsFromText(draft.replaceTags);

  if (replaceTags.length > 0) {
    return withoutUndefined({
      folder,
      replaceTags,
    });
  }

  return withoutUndefined({
    addTags: tagsFromText(draft.addTags),
    folder,
    removeTags: tagsFromText(draft.removeTags),
  });
}

function tagsFromText(value: string) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const tag of value.split(",")) {
    const trimmed = tag.trim();
    const key = trimmed.toLocaleLowerCase();

    if (trimmed && !seen.has(key)) {
      seen.add(key);
      tags.push(trimmed);
    }
  }

  return tags;
}

function textOrUndefined(value: string) {
  const trimmed = value.trim();

  return trimmed || undefined;
}

function withoutUndefined<T extends Record<string, string | string[] | undefined>>(input: T) {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => {
      const value = entry[1];

      return Array.isArray(value) ? value.length > 0 : value !== undefined;
    }),
  ) as Omit<RecordingBulkMetadataUpdate, "recordingIds">;
}
