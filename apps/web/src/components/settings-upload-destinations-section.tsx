import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  s3ProviderPresets,
  type S3ProviderConfig,
  type S3ProviderPreset,
  type SmbProviderConfig,
  type UploadDestinationInput,
  type UploadDestinationKind,
  type UploadDestinationRuntimeStatus,
  type UploadDestinationUpdate,
} from "@rakkr/shared";
import { Pencil, PlusCircle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Field, Toggle } from "@/components/settings-fields";
import { HintButton } from "@/components/hint-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { uploadProviderStatusClass } from "@/lib/upload-status";
import { cn } from "@/lib/utils";

interface DestinationDraft {
  displayName: string;
  enabled: boolean;
  kind: UploadDestinationKind;
  s3: S3ProviderConfig;
  s3SecretAccessKey: string;
  smb: SmbProviderConfig;
  smbPassword: string;
}

type EditorState =
  | { destination?: undefined; mode: "create" }
  | { destination: UploadDestinationRuntimeStatus; mode: "edit" };

export function SettingsUploadDestinationsSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>();
  const [pendingDelete, setPendingDelete] = useState<UploadDestinationRuntimeStatus>();
  const destinationsQuery = useQuery({
    enabled: canRead,
    queryFn: api.uploadDestinations,
    queryKey: ["upload-destinations"],
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteUploadDestination(id),
    onError: () =>
      toast.error("Delete failed", {
        description: "The upload destination could not be deleted.",
      }),
    onSuccess: () => {
      toast.success("Upload destination deleted");
      void queryClient.invalidateQueries({ queryKey: ["upload-destinations"] });
      setPendingDelete(undefined);
    },
  });
  const destinations = destinationsQuery.data?.data ?? [];
  const enabledCount = destinations.filter((destination) => destination.enabled).length;
  const columns = uploadDestinationColumns({
    canManage,
    onDelete: setPendingDelete,
    onEdit: (destination) => setEditor({ destination, mode: "edit" }),
  });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Destinations</h2>
          <p className="text-sm text-muted-foreground">
            Named SMB and S3 storage targets. Upload policies select a destination; recordings
            upload over the network with no mounts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {enabledCount} enabled
          </Badge>
          <HintButton
            disabled={!canManage}
            hint={canManage ? "Add upload destination" : "Requires settings manage"}
            onClick={() => setEditor({ mode: "create" })}
            variant="outline"
          >
            <PlusCircle className="size-4" />
            New
          </HintButton>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={destinations}
          emptyMessage="No upload destinations are configured."
          getRowId={(destination) => destination.id}
          isLoading={destinationsQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditor(undefined))}
        open={Boolean(editor)}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit" ? "Edit Upload Destination" : "New Upload Destination"}
            </DialogTitle>
            <DialogDescription>
              Configure the server/share or bucket, region or endpoint, and credentials for direct
              uploads.
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <UploadDestinationEditor
              canManage={canManage}
              destination={editor.mode === "edit" ? editor.destination : undefined}
              onSaved={() => setEditor(undefined)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => (open ? undefined : setPendingDelete(undefined))}
        open={Boolean(pendingDelete)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete upload destination?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.displayName}" will be removed. Policies pointing at it will fail until repointed.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UploadDestinationEditor({
  canManage,
  destination,
  onSaved,
}: {
  canManage: boolean;
  destination?: UploadDestinationRuntimeStatus;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const isCreate = !destination;
  const [draft, setDraft] = useState<DestinationDraft>(() => initialDraft(destination));
  const mutation = useMutation({
    mutationFn: () =>
      destination
        ? api.updateUploadDestination(destination.id, buildUpdate(draft))
        : api.createUploadDestination(buildCreate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The upload destination could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Upload destination saved");
      void queryClient.invalidateQueries({ queryKey: ["upload-destinations"] });
      onSaved();
    },
  });

  useEffect(() => {
    setDraft(initialDraft(destination));
  }, [destination]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayName: event.target.value }))
            }
            value={draft.displayName}
          />
        </Field>
        <Field label="Kind">
          <Select
            disabled={!canManage || !isCreate}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, kind: value as UploadDestinationKind }))
            }
            value={draft.kind}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smb">SMB</SelectItem>
              <SelectItem value="s3">S3</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Toggle
        checked={draft.enabled}
        disabled={!canManage}
        label="Enabled"
        onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
      />

      {draft.kind === "smb" ? (
        <SmbFields
          canManage={canManage}
          draft={draft}
          hasPassword={destination?.hasSmbPassword ?? false}
          setDraft={setDraft}
        />
      ) : (
        <S3Fields
          canManage={canManage}
          draft={draft}
          hasSecret={destination?.hasS3SecretAccessKey ?? false}
          setDraft={setDraft}
        />
      )}

      {destination ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Required{" "}
            {destination.requiredFields.length ? destination.requiredFields.join(", ") : "none"}
          </span>
          {destination.missingFields.length > 0 ? (
            <span className="text-destructive">Missing {destination.missingFields.join(", ")}</span>
          ) : null}
          {destination.reason ? <span>{destination.reason}</span> : null}
        </div>
      ) : null}

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save upload destination" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SmbFields({
  canManage,
  draft,
  hasPassword,
  setDraft,
}: {
  canManage: boolean;
  draft: DestinationDraft;
  hasPassword: boolean;
  setDraft: React.Dispatch<React.SetStateAction<DestinationDraft>>;
}) {
  const updateSmb = (patch: Partial<SmbProviderConfig>) =>
    setDraft((current) => ({ ...current, smb: { ...current.smb, ...patch } }));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Server">
        <Input
          disabled={!canManage}
          onChange={(event) => updateSmb({ server: event.target.value })}
          placeholder="files.example.lan"
          value={draft.smb.server ?? ""}
        />
      </Field>
      <Field label="Share">
        <Input
          disabled={!canManage}
          onChange={(event) => updateSmb({ share: event.target.value })}
          placeholder="recordings"
          value={draft.smb.share ?? ""}
        />
      </Field>
      <Field label="Domain (optional)">
        <Input
          disabled={!canManage}
          onChange={(event) => updateSmb({ domain: event.target.value })}
          placeholder="WORKGROUP"
          value={draft.smb.domain ?? ""}
        />
      </Field>
      <Field label="Username">
        <Input
          autoComplete="off"
          disabled={!canManage}
          onChange={(event) => updateSmb({ username: event.target.value })}
          value={draft.smb.username ?? ""}
        />
      </Field>
      <Field label="Password">
        <Input
          autoComplete="new-password"
          disabled={!canManage}
          onChange={(event) =>
            setDraft((current) => ({ ...current, smbPassword: event.target.value }))
          }
          placeholder={hasPassword ? "•••••••• (unchanged)" : ""}
          type="password"
          value={draft.smbPassword}
        />
      </Field>
      <Field label="Upload path (optional)">
        <Input
          disabled={!canManage}
          onChange={(event) => updateSmb({ path: event.target.value })}
          placeholder="meetings/2026"
          value={draft.smb.path ?? ""}
        />
      </Field>
      <Field label="Port (optional)">
        <Input
          disabled={!canManage}
          onChange={(event) => updateSmb({ port: parsePort(event.target.value) })}
          placeholder="445"
          type="number"
          value={draft.smb.port ?? ""}
        />
      </Field>
    </div>
  );
}

function S3Fields({
  canManage,
  draft,
  hasSecret,
  setDraft,
}: {
  canManage: boolean;
  draft: DestinationDraft;
  hasSecret: boolean;
  setDraft: React.Dispatch<React.SetStateAction<DestinationDraft>>;
}) {
  const regionListId = useId();
  const preset = s3ProviderPresets.find((entry) => entry.preset === draft.s3.preset);
  const updateS3 = (patch: Partial<S3ProviderConfig>) =>
    setDraft((current) => ({ ...current, s3: { ...current.s3, ...patch } }));

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Provider">
        <Select
          disabled={!canManage}
          onValueChange={(value) =>
            setDraft((current) => applyPreset(current, value as S3ProviderPreset))
          }
          value={draft.s3.preset ?? "aws"}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {s3ProviderPresets.map((entry) => (
              <SelectItem key={entry.preset} value={entry.preset}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={preset?.regionRequired ? "Region" : "Region (optional)"}>
        <Input
          disabled={!canManage}
          list={regionListId}
          onChange={(event) => updateS3({ region: event.target.value })}
          placeholder={preset?.defaultRegion ?? "us-east-1"}
          value={draft.s3.region ?? ""}
        />
        {preset?.regionOptions ? (
          <datalist id={regionListId}>
            {preset.regionOptions.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </datalist>
        ) : null}
      </Field>
      <Field label={preset?.endpointRequired ? "Endpoint" : "Endpoint (optional)"}>
        <Input
          disabled={!canManage}
          onChange={(event) => updateS3({ endpoint: event.target.value })}
          placeholder={preset?.endpointPlaceholder ?? "https://s3.amazonaws.com"}
          value={draft.s3.endpoint ?? ""}
        />
      </Field>
      <Field label="Bucket">
        <Input
          disabled={!canManage}
          onChange={(event) => updateS3({ bucket: event.target.value })}
          placeholder="rakkr-recordings"
          value={draft.s3.bucket ?? ""}
        />
      </Field>
      <Field label="Upload path (optional)">
        <Input
          disabled={!canManage}
          onChange={(event) => updateS3({ prefix: event.target.value })}
          placeholder="meetings/2026"
          value={draft.s3.prefix ?? ""}
        />
      </Field>
      <Field label="Access key ID">
        <Input
          autoComplete="off"
          disabled={!canManage}
          onChange={(event) => updateS3({ accessKeyId: event.target.value })}
          value={draft.s3.accessKeyId ?? ""}
        />
      </Field>
      <Field label="Secret access key">
        <Input
          autoComplete="new-password"
          disabled={!canManage}
          onChange={(event) =>
            setDraft((current) => ({ ...current, s3SecretAccessKey: event.target.value }))
          }
          placeholder={hasSecret ? "•••••••• (unchanged)" : ""}
          type="password"
          value={draft.s3SecretAccessKey}
        />
      </Field>
      <Toggle
        checked={draft.s3.forcePathStyle ?? false}
        disabled={!canManage}
        label="Force path-style URLs"
        onChange={(checked) => updateS3({ forcePathStyle: checked })}
      />
    </div>
  );
}

function initialDraft(destination?: UploadDestinationRuntimeStatus): DestinationDraft {
  return {
    displayName: destination?.displayName ?? "",
    enabled: destination?.enabled ?? false,
    kind: destination?.kind ?? "smb",
    s3: { preset: "aws", ...destination?.s3 },
    s3SecretAccessKey: "",
    smb: { ...destination?.smb },
    smbPassword: "",
  };
}

function applyPreset(draft: DestinationDraft, preset: S3ProviderPreset): DestinationDraft {
  const info = s3ProviderPresets.find((entry) => entry.preset === preset);

  return {
    ...draft,
    s3: {
      ...draft.s3,
      forcePathStyle: info?.forcePathStyle ?? draft.s3.forcePathStyle,
      preset,
      region: draft.s3.region || info?.defaultRegion || draft.s3.region,
    },
  };
}

function buildCreate(draft: DestinationDraft): UploadDestinationInput {
  if (draft.kind === "smb") {
    return {
      displayName: draft.displayName,
      enabled: draft.enabled,
      kind: "smb",
      smb: cleanSmb(draft.smb),
      ...(draft.smbPassword ? { smbPassword: draft.smbPassword } : {}),
    };
  }

  return {
    displayName: draft.displayName,
    enabled: draft.enabled,
    kind: "s3",
    s3: cleanS3(draft.s3),
    ...(draft.s3SecretAccessKey ? { s3SecretAccessKey: draft.s3SecretAccessKey } : {}),
  };
}

function buildUpdate(draft: DestinationDraft): UploadDestinationUpdate {
  if (draft.kind === "smb") {
    return {
      displayName: draft.displayName,
      enabled: draft.enabled,
      smb: cleanSmb(draft.smb),
      ...(draft.smbPassword ? { smbPassword: draft.smbPassword } : {}),
    };
  }

  return {
    displayName: draft.displayName,
    enabled: draft.enabled,
    s3: cleanS3(draft.s3),
    ...(draft.s3SecretAccessKey ? { s3SecretAccessKey: draft.s3SecretAccessKey } : {}),
  };
}

function cleanSmb(smb: SmbProviderConfig): SmbProviderConfig {
  return {
    domain: cleanText(smb.domain),
    path: cleanText(smb.path),
    port: smb.port,
    server: cleanText(smb.server),
    share: cleanText(smb.share),
    username: cleanText(smb.username),
  };
}

function cleanS3(s3: S3ProviderConfig): S3ProviderConfig {
  return {
    accessKeyId: cleanText(s3.accessKeyId),
    bucket: cleanText(s3.bucket),
    endpoint: cleanText(s3.endpoint),
    forcePathStyle: s3.forcePathStyle,
    preset: s3.preset,
    prefix: cleanText(s3.prefix),
    region: cleanText(s3.region),
  };
}

function cleanText(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function parsePort(value: string) {
  const parsed = Number(value.trim());

  return value.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function uploadDestinationColumns({
  canManage,
  onDelete,
  onEdit,
}: {
  canManage: boolean;
  onDelete: (destination: UploadDestinationRuntimeStatus) => void;
  onEdit: (destination: UploadDestinationRuntimeStatus) => void;
}): ColumnDef<UploadDestinationRuntimeStatus>[] {
  const columns: ColumnDef<UploadDestinationRuntimeStatus>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.displayName}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => <span className="text-sm uppercase">{row.original.kind}</span>,
      header: "Kind",
      id: "kind",
    },
    {
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.target ?? "-"}
        </span>
      ),
      header: "Target",
      id: "target",
    },
    {
      cell: ({ row }) => (
        <Badge className={uploadProviderStatusClass(row.original.status)} variant="outline">
          {row.original.status}
        </Badge>
      ),
      header: "Status",
      id: "status",
    },
  ];

  columns.push({
    cell: ({ row }) => (
      <div className="flex justify-end gap-2">
        <Button
          disabled={!canManage}
          onClick={() => onEdit(row.original)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Pencil className="size-4" />
          Edit
        </Button>
        <Button
          disabled={!canManage}
          onClick={() => onDelete(row.original)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Trash2 className="size-4" />
          <span className="sr-only">Delete</span>
        </Button>
      </div>
    ),
    header: () => <span className="sr-only">Actions</span>,
    id: "actions",
    meta: { cellClassName: "text-right", headClassName: "text-right" },
  });

  return columns;
}
