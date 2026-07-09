import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  FileAudio,
  NotebookText,
  Pencil,
  Radio,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";

import { ConfirmButton } from "@/components/confirm-button";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { RoomRosterEditor } from "@/components/room-roster-editor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { api, apiErrorStatus } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { useDocumentTitle } from "@/lib/document-title";
import { nodeStatusBadgeClass, nodeStatusLabel } from "@/lib/node-status";
import {
  roomDraftFromRoom,
  roomDraftToUpdate,
  roomPageActionPermissions,
  type RoomDraft,
} from "@/lib/room-page-helpers";

export function RoomDetailPage({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<RoomDraft>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = roomPageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const overviewQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: () => api.roomOverview(roomId),
    queryKey: ["room-overview", roomId],
  });
  const updateRoomMutation = useMutation({
    mutationFn: (input: RoomDraft) => api.updateRoom(roomId, roomDraftToUpdate(input)),
    onError: () =>
      toast.error("Save failed", {
        description: "The room could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Room updated");
      void queryClient.invalidateQueries({ queryKey: ["room-overview", roomId] });
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      setEditOpen(false);
    },
  });
  const deleteRoomMutation = useMutation({
    mutationFn: () => api.deleteRoom(roomId),
    onError: (error) => {
      if (apiErrorStatus(error) === 409) {
        toast.error("Room in use", {
          description:
            "This room is still referenced by one or more schedules and cannot be deleted.",
        });
        return;
      }

      toast.error("Delete failed", {
        description: "The room could not be deleted.",
      });
    },
    onSuccess: () => {
      toast.success("Room deleted");
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void navigate({ to: "/rooms" });
    },
  });

  // Must run on every render, before any early return — hooks cannot be
  // conditional (a pending→resolved transition would otherwise change the hook
  // count and crash the page). Mirrors schedule-detail.tsx.
  useDocumentTitle(overviewQuery.data?.data?.room.name);

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading room" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <div className="grid gap-4">
        <Button
          className="w-fit"
          variant="outline"
          nativeButton={false}
          render={
            <Link to="/rooms">
              <ArrowLeft className="size-4" />
              Rooms
            </Link>
          }
        />
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>Room</AlertTitle>
          <AlertDescription>Room details are unavailable.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (overviewQuery.isPending) {
    return <LoadingSkeleton label="Loading room" />;
  }

  const overview = overviewQuery.data?.data;

  if (!overview) {
    return (
      <div className="grid gap-4">
        <Button
          className="w-fit"
          variant="outline"
          nativeButton={false}
          render={
            <Link to="/rooms">
              <ArrowLeft className="size-4" />
              Rooms
            </Link>
          }
        />
        <Alert>
          <AlertDescription>Room not found.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const room = overview.room;

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <Button
            className="mb-3 w-fit"
            variant="outline"
            nativeButton={false}
            render={
              <Link to="/rooms">
                <ArrowLeft className="size-4" />
                Rooms
              </Link>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Building2 className="size-5 text-primary" />
            <h2 className="text-lg font-semibold">{room.name}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[room.site, room.building, room.floor].filter(Boolean).join(" / ")}
          </p>
        </div>
        {actionPermissions.canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={openEdit} type="button" variant="outline">
              <Pencil className="size-4" />
              Edit
            </Button>
            <ConfirmButton
              confirmLabel="Delete"
              description={`This permanently deletes the room "${room.name}". Rooms still referenced by a schedule cannot be deleted.`}
              disabled={deleteRoomMutation.isPending}
              onConfirm={() => deleteRoomMutation.mutate()}
              title={`Delete room "${room.name}"?`}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </ConfirmButton>
          </div>
        ) : null}
      </div>

      {room.description ? (
        <Card className="rounded-lg p-4 shadow-sm">
          <p className="text-sm text-muted-foreground">{room.description}</p>
        </Card>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={NotebookText} title="Notes" />
          <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {room.notes || "No notes recorded for this room."}
          </p>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={Radio} title="Inventory" />
          <div className="mt-3 grid gap-2">
            {overview.nodes.map((node) => (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-transparent p-3 text-sm"
                key={node.id}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{node.alias}</span>
                <span className="truncate text-xs text-muted-foreground">{node.hostname}</span>
                <Badge className={nodeStatusBadgeClass(node.status)} variant="outline">
                  {nodeStatusLabel(node.status)}
                </Badge>
              </div>
            ))}
            {overview.nodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No nodes are assigned to this room.</p>
            ) : null}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={CalendarClock} title="Upcoming" />
          <ol className="mt-3 grid gap-3 border-l border-border pl-3 text-sm">
            {overview.upcoming.map((occurrence) => (
              <li key={`${occurrence.scheduleId}-${occurrence.recordingStartAt}`}>
                <div className="font-medium">{formatDateTime(occurrence.recordingStartAt)}</div>
                <div className="text-muted-foreground">
                  <Link
                    className="hover:underline"
                    params={{ scheduleId: occurrence.scheduleId }}
                    to="/schedules/$scheduleId"
                  >
                    {occurrence.scheduleName}
                  </Link>
                  {occurrence.scheduledByName
                    ? ` / scheduled by ${occurrence.scheduledByName}`
                    : null}
                </div>
              </li>
            ))}
            {overview.upcoming.length === 0 ? (
              <li className="text-muted-foreground">No upcoming recordings.</li>
            ) : null}
          </ol>
        </Card>

        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={FileAudio} title="Recent Recordings" />
          <div className="mt-3 grid gap-2">
            {overview.recentRecordings.map((recording) => (
              <div
                className="rounded-md border border-border bg-transparent p-3 text-sm"
                key={recording.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{recording.name}</span>
                  <Badge variant="secondary">{recording.status}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(recording.recordedAt)}
                </div>
              </div>
            ))}
            {overview.recentRecordings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent recordings.</p>
            ) : null}
          </div>
        </Card>
      </section>

      {actionPermissions.canManageRoster ? (
        <Card className="rounded-lg p-4 shadow-sm">
          <SectionTitle icon={Users} title="Roster" />
          <div className="mt-3">
            <RoomRosterEditor roomId={roomId} />
          </div>
        </Card>
      ) : null}

      {actionPermissions.canManage && draft ? (
        <Dialog onOpenChange={(open) => (open ? setEditOpen(true) : closeEdit())} open={editOpen}>
          <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Room</DialogTitle>
              <DialogDescription>Update this room&apos;s identity and notes.</DialogDescription>
            </DialogHeader>

            <form
              className="grid gap-4"
              id="room-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft) {
                  updateRoomMutation.mutate(draft);
                }
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="room-edit-name">Name</Label>
                  <Input
                    id="room-edit-name"
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, name: event.target.value })
                    }
                    required
                    value={draft.name}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-edit-site">Site</Label>
                  <Input
                    id="room-edit-site"
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, site: event.target.value })
                    }
                    required
                    value={draft.site}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-edit-building">Building</Label>
                  <Input
                    id="room-edit-building"
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, building: event.target.value })
                    }
                    value={draft.building}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-edit-floor">Floor</Label>
                  <Input
                    id="room-edit-floor"
                    onChange={(event) =>
                      setDraft((current) => current && { ...current, floor: event.target.value })
                    }
                    value={draft.floor}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="room-edit-description">Description</Label>
                <Textarea
                  id="room-edit-description"
                  onChange={(event) =>
                    setDraft(
                      (current) => current && { ...current, description: event.target.value },
                    )
                  }
                  value={draft.description}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="room-edit-notes">Notes</Label>
                <Textarea
                  id="room-edit-notes"
                  onChange={(event) =>
                    setDraft((current) => current && { ...current, notes: event.target.value })
                  }
                  value={draft.notes}
                />
              </div>
            </form>

            <DialogFooter>
              <Button onClick={closeEdit} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={updateRoomMutation.isPending} form="room-edit-form" type="submit">
                <Pencil className="size-4" />
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );

  function openEdit() {
    setDraft(roomDraftFromRoom(room));
    setEditOpen(true);
  }

  function closeEdit() {
    setEditOpen(false);
    setDraft(undefined);
  }
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Building2; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-5 text-primary" />
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
  );
}
