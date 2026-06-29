import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  s3ProviderPresets,
  type S3ProviderConfig,
  type S3ProviderPreset,
  type SmbProviderConfig,
  type UploadProviderConfigUpdate,
  type UploadProviderRuntimeStatus,
} from "@rakkr/shared";
import { Pencil, Save } from "lucide-react";
import { toast } from "sonner";

import { Field, Toggle } from "@/components/settings-fields";
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

interface ProviderDraft {
  displayName: string;
  enabled: boolean;
  s3: S3ProviderConfig;
  s3SecretAccessKey: string;
  smb: SmbProviderConfig;
  smbPassword: string;
}

export function SettingsUploadProvidersSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const [editing, setEditing] = useState<UploadProviderRuntimeStatus>();
  const providersQuery = useQuery({
    enabled: canRead,
    queryFn: api.uploadProviders,
    queryKey: ["upload-providers"],
  });
  // `stub` is an API/test-only provider and is never shown in the operator UI.
  const providers = (providersQuery.data?.data ?? []).filter(
    (provider) => provider.provider !== "stub",
  );
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const columns = uploadProviderColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Providers</h2>
          <p className="text-sm text-muted-foreground">
            Direct SMB and S3 storage targets. Recordings upload over the network with no mounts.
          </p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {enabledCount} enabled
        </Badge>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={providers}
          emptyMessage="No upload providers are available."
          getRowId={(provider) => provider.provider}
          isLoading={providersQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editing)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit {editing?.provider === "s3" ? "S3 Bucket" : "SMB Share"}</DialogTitle>
            <DialogDescription>
              {editing?.provider === "s3"
                ? "Configure the bucket, region or endpoint, and access keys for direct S3 uploads."
                : "Configure the server, share, and credentials for direct SMB uploads."}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <UploadProviderEditor
              canManage={canManage}
              onSaved={() => setEditing(undefined)}
              provider={editing}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UploadProviderEditor({
  canManage,
  onSaved,
  provider,
}: {
  canManage: boolean;
  onSaved: () => void;
  provider: UploadProviderRuntimeStatus;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProviderDraft>(() => initialDraft(provider));
  const mutation = useMutation({
    mutationFn: () => api.updateUploadProvider(provider.provider, buildUpdate(provider, draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The upload provider settings could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Upload provider saved");
      void queryClient.invalidateQueries({ queryKey: ["upload-providers"] });
      onSaved();
    },
  });

  useEffect(() => {
    setDraft(initialDraft(provider));
  }, [provider]);

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
        <Toggle
          checked={draft.enabled}
          disabled={!canManage}
          label="Enabled"
          onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
        />
      </div>

      {provider.provider === "smb" ? (
        <SmbFields
          canManage={canManage}
          draft={draft}
          hasPassword={provider.hasSmbPassword}
          setDraft={setDraft}
        />
      ) : (
        <S3Fields
          canManage={canManage}
          draft={draft}
          hasSecret={provider.hasS3SecretAccessKey}
          setDraft={setDraft}
        />
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Required {provider.requiredFields.length ? provider.requiredFields.join(", ") : "none"}
        </span>
        {provider.missingFields.length > 0 ? (
          <span className="text-destructive">Missing {provider.missingFields.join(", ")}</span>
        ) : null}
        {provider.reason ? <span>{provider.reason}</span> : null}
      </div>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button disabled={mutation.isPending || !canManage} onClick={() => mutation.mutate()}>
                <Save className="size-4" />
                Save
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {canManage ? "Save upload provider" : "Requires settings manage"}
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
  draft: ProviderDraft;
  hasPassword: boolean;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
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
  draft: ProviderDraft;
  hasSecret: boolean;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
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
          <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
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

function initialDraft(provider: UploadProviderRuntimeStatus): ProviderDraft {
  return {
    displayName: provider.displayName,
    enabled: provider.enabled,
    s3: { preset: "aws", ...provider.s3 },
    s3SecretAccessKey: "",
    smb: { ...provider.smb },
    smbPassword: "",
  };
}

function applyPreset(draft: ProviderDraft, preset: S3ProviderPreset): ProviderDraft {
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

function buildUpdate(
  provider: UploadProviderRuntimeStatus,
  draft: ProviderDraft,
): UploadProviderConfigUpdate {
  if (provider.provider === "smb") {
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

function uploadProviderColumns({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (provider: UploadProviderRuntimeStatus) => void;
}): ColumnDef<UploadProviderRuntimeStatus>[] {
  const columns: ColumnDef<UploadProviderRuntimeStatus>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.displayName}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.provider}</div>
        </div>
      ),
      header: "Name",
      id: "name",
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
      <div className="flex justify-end">
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
      </div>
    ),
    header: () => <span className="sr-only">Actions</span>,
    id: "actions",
    meta: { cellClassName: "text-right", headClassName: "text-right" },
  });

  return columns;
}
