import { CheckSquare, Download, Pencil, Save, Trash2, UploadCloud, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { UploadPolicy } from "@rakkr/shared";

import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RecordingBulkMetadataUpdate } from "@/lib/api";
import { tagsFromText } from "@/lib/recording-page-helpers";

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
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [selectedUploadPolicyId, setSelectedUploadPolicyId] = useState(uploadPolicies[0]?.id ?? "");
  const bulkDeleteDisabled = deleteDisabled || selectedCount === 0 || deleteEligibleCount === 0;
  const bulkExportDisabled = exportDisabled || selectedCount === 0;
  const bulkUploadDisabled = uploadDisabled || selectedCount === 0 || uploadEligibleCount === 0;
  const uploadPolicyId = selectedUploadPolicyId || uploadPolicies[0]?.id;

  // Fold the eligibility counts into the selected badge, only surfacing the ones
  // the operator is permitted to act on (deletable needs canDelete, cached canUpload).
  const selectionDetails: string[] = [];
  if (canDelete) {
    selectionDetails.push(`${deleteEligibleCount} deletable`);
  }
  if (canUpload) {
    selectionDetails.push(`${uploadEligibleCount} cached`);
  }
  const selectionSummary = `${selectedCount} selected${
    selectionDetails.length > 0 ? ` (${selectionDetails.join(", ")})` : ""
  }`;

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Bulk organize</h3>
          <Badge variant="secondary">{selectionSummary}</Badge>
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
          {canEdit ? (
            <Button
              disabled={disabled || selectedCount === 0}
              onClick={() => setOrganizeOpen(true)}
              type="button"
              variant="outline"
            >
              <Pencil className="size-4" />
              Organize metadata
            </Button>
          ) : null}
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
          {canDelete ? (
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
          ) : null}
        </div>
      </div>
      {canEdit ? (
        <BulkOrganizeDialog
          disabled={disabled}
          onApply={(input) => {
            onApply(input);
            setOrganizeOpen(false);
          }}
          onOpenChange={setOrganizeOpen}
          open={organizeOpen}
          selectedCount={selectedCount}
        />
      ) : null}
      {canUpload ? (
        <div className="flex flex-wrap items-center gap-2">
          {uploadPolicies.length > 0 ? (
            <Select
              onValueChange={(value) => setSelectedUploadPolicyId(value)}
              value={uploadPolicyId ?? ""}
            >
              <SelectTrigger className="w-full">
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

function BulkOrganizeDialog({
  disabled,
  onApply,
  onOpenChange,
  open,
  selectedCount,
}: {
  disabled: boolean;
  onApply: (input: Omit<RecordingBulkMetadataUpdate, "recordingIds">) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  selectedCount: number;
}) {
  const form = useForm<BulkDraft>({ defaultValues: emptyBulkDraft });

  // Reset the metadata draft each time the dialog opens so a stale folder or tag
  // edit never carries over to a different selection.
  useEffect(() => {
    if (open) {
      form.reset(emptyBulkDraft);
    }
  }, [form, open]);

  const draft = form.watch();
  const input = bulkInputFromDraft(draft);
  const applyDisabled = disabled || selectedCount === 0 || Object.keys(input).length === 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Organize Recordings</DialogTitle>
          <DialogDescription>
            Apply folder and tag changes to the {selectedCount} selected recording
            {selectedCount === 1 ? "" : "s"}. Replace tags takes precedence over add/remove.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            className="grid gap-4 md:grid-cols-2"
            id="recording-bulk-form"
            onSubmit={form.handleSubmit(() => onApply(input))}
          >
            <FormField
              control={form.control}
              name="folder"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Folder</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="addTags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Add Tags</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="removeTags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Remove Tags</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="replaceTags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Replace Tags</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={applyDisabled} form="recording-bulk-form" type="submit">
            <Save className="size-4" />
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
