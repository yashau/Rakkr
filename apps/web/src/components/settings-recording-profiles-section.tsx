import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { RecordingProfile } from "@rakkr/shared";
import { Pencil, PlusCircle } from "lucide-react";
import { toast } from "sonner";

import { HintButton } from "@/components/hint-button";
import {
  RecordingProfileSettingsCard,
  defaultRecordingProfileInput,
} from "@/components/recording-profile-settings-card";
import { DefaultBadge, SetDefaultButton } from "@/components/set-default-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { TruncateCell } from "@/components/ui/truncate-cell";
import { useSchedulingDefault } from "@/lib/scheduling-defaults";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

export function SettingsRecordingProfilesSection({
  canManage,
  canRead,
}: {
  canManage: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RecordingProfile>();
  const profilesQuery = useQuery({
    enabled: canRead,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const createMutation = useMutation({
    mutationFn: () => api.createRecordingProfile(defaultRecordingProfileInput()),
    onError: () =>
      toast.error("Create failed", {
        description: "The recording profile could not be created.",
      }),
    onSuccess: ({ data }) => {
      toast.success("Recording profile created");
      void queryClient.invalidateQueries({ queryKey: ["recording-profiles"] });
      setEditing(data);
    },
  });
  const {
    defaultId,
    isPending: isTogglingDefault,
    toggleDefault,
  } = useSchedulingDefault("defaultRecordingProfileId", canRead);
  const profiles = profilesQuery.data?.data ?? [];
  const columns = recordingProfileColumns({
    canManage,
    defaultId,
    isTogglingDefault,
    onEdit: setEditing,
    onToggleDefault: toggleDefault,
  });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recording Profiles</h2>
          <p className="text-sm text-muted-foreground">Central audio defaults and templates.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {profiles.length} profiles
          </Badge>
          <HintButton
            disabled={createMutation.isPending || !canManage}
            hint={canManage ? "Create recording profile" : "Requires settings manage"}
            onClick={() => createMutation.mutate()}
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
          data={profiles}
          emptyMessage="No recording profiles are configured."
          getRowId={(profile) => profile.id}
          isLoading={profilesQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        open={Boolean(editing)}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Recording Profile</DialogTitle>
            <DialogDescription>
              Update codec, channel, silence, and enhancement settings for this profile.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <RecordingProfileSettingsCard
              canManage={canManage}
              onSaved={() => setEditing(undefined)}
              profile={editing}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function recordingProfileColumns({
  canManage,
  defaultId,
  isTogglingDefault,
  onEdit,
  onToggleDefault,
}: {
  canManage: boolean;
  defaultId: string | null;
  isTogglingDefault: boolean;
  onEdit: (profile: RecordingProfile) => void;
  onToggleDefault: (id: string) => void;
}): ColumnDef<RecordingProfile>[] {
  const columns: ColumnDef<RecordingProfile>[] = [
    {
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0">
            <TruncateCell className="max-w-64 font-medium text-foreground">
              {row.original.name}
            </TruncateCell>
            <TruncateCell className="max-w-64 font-mono text-xs text-muted-foreground">
              {row.original.id}
            </TruncateCell>
          </div>
          {row.original.id === defaultId ? <DefaultBadge /> : null}
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap">
          {row.original.codec.toUpperCase()} / {row.original.bitrateKbps} kbps
        </span>
      ),
      header: "Codec",
      id: "codec",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.channelMode}</span>,
      header: "Channel Mode",
      id: "channel-mode",
    },
    {
      cell: ({ row }) => (
        <Badge
          className={row.original.enhancement?.denoise.enabled ? toneBadgeClass("info") : undefined}
          variant={row.original.enhancement?.denoise.enabled ? "outline" : "secondary"}
        >
          {row.original.enhancement?.denoise.enabled ? "denoise on" : "denoise off"}
        </Badge>
      ),
      header: "Enhancement",
      id: "enhancement",
    },
  ];

  columns.push({
    cell: ({ row }) => (
      <div className="flex justify-end gap-2">
        <SetDefaultButton
          canManage={canManage}
          isDefault={row.original.id === defaultId}
          isPending={isTogglingDefault}
          onToggle={() => onToggleDefault(row.original.id)}
        />
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
