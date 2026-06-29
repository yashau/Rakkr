import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { RecordingProfile } from "@rakkr/shared";
import { Pencil } from "lucide-react";

import { RecordingProfileSettingsCard } from "@/components/recording-profile-settings-card";
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
  const [editing, setEditing] = useState<RecordingProfile>();
  const profilesQuery = useQuery({
    enabled: canRead,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const profiles = profilesQuery.data?.data ?? [];
  const columns = recordingProfileColumns({ canManage, onEdit: setEditing });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recording Profiles</h2>
          <p className="text-sm text-muted-foreground">Central audio defaults and templates.</p>
        </div>
        <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
          {profiles.length} profiles
        </Badge>
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
  onEdit,
}: {
  canManage: boolean;
  onEdit: (profile: RecordingProfile) => void;
}): ColumnDef<RecordingProfile>[] {
  const columns: ColumnDef<RecordingProfile>[] = [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.name}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div>
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
