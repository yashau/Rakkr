import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Building2, PlusCircle, ShieldCheck } from "lucide-react";
import type { Room } from "@rakkr/shared";
import { toast } from "sonner";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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
import { api } from "@/lib/api";
import {
  emptyRoomDraft,
  roomDraftToInput,
  roomPageActionPermissions,
  type RoomDraft,
} from "@/lib/room-page-helpers";

export function RoomsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<RoomDraft>(emptyRoomDraft);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = roomPageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const roomsQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: api.rooms,
    queryKey: ["rooms"],
  });
  const createRoomMutation = useMutation({
    mutationFn: () => api.createRoom(roomDraftToInput(draft)),
    onError: () =>
      toast.error("Create failed", {
        description: "The room could not be created.",
      }),
    onSuccess: () => {
      toast.success("Room created");
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      closeDialog();
    },
  });

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading rooms" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Rooms</AlertTitle>
        <AlertDescription>Rooms are unavailable.</AlertDescription>
      </Alert>
    );
  }

  const rooms = roomsQuery.data?.data ?? [];
  const columns = roomColumns();

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Rooms</h2>
            <p className="text-sm text-muted-foreground">{rooms.length} rooms</p>
          </div>
          {actionPermissions.canManage ? (
            <Button onClick={openCreate} type="button">
              <PlusCircle className="size-4" />
              Add room
            </Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={rooms}
          emptyMessage="No rooms have been created yet."
          getRowId={(room) => room.id}
          isLoading={roomsQuery.isPending}
        />
      </section>

      {actionPermissions.canManage ? (
        <Dialog
          onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
          open={dialogOpen}
        >
          <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Room</DialogTitle>
              <DialogDescription>
                Add a first-class room. Nodes and schedules can then be assigned to it.
              </DialogDescription>
            </DialogHeader>

            <form
              className="grid gap-4"
              id="room-form"
              onSubmit={(event) => {
                event.preventDefault();
                createRoomMutation.mutate();
              }}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="room-name">Name</Label>
                  <Input
                    id="room-name"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    required
                    value={draft.name}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-site">Site</Label>
                  <Input
                    id="room-site"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, site: event.target.value }))
                    }
                    required
                    value={draft.site}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-building">Building</Label>
                  <Input
                    id="room-building"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, building: event.target.value }))
                    }
                    value={draft.building}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="room-floor">Floor</Label>
                  <Input
                    id="room-floor"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, floor: event.target.value }))
                    }
                    value={draft.floor}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="room-description">Description</Label>
                <Textarea
                  id="room-description"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  value={draft.description}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="room-notes">Notes</Label>
                <Textarea
                  id="room-notes"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, notes: event.target.value }))
                  }
                  value={draft.notes}
                />
              </div>
            </form>

            <DialogFooter>
              <Button onClick={closeDialog} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={createRoomMutation.isPending} form="room-form" type="submit">
                <PlusCircle className="size-4" />
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );

  function openCreate() {
    setDraft(emptyRoomDraft);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setDraft(emptyRoomDraft);
  }
}

function roomColumns(): ColumnDef<Room>[] {
  return [
    {
      cell: ({ row }) => (
        <Link
          className="font-medium text-foreground hover:underline"
          params={{ roomId: row.original.id }}
          to="/rooms/$roomId"
        >
          {row.original.name}
        </Link>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => <span className="text-sm">{row.original.site}</span>,
      header: "Site",
      id: "site",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{buildingFloorLabel(row.original)}</span>
      ),
      header: "Building / Floor",
      id: "building-floor",
    },
    {
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 className="size-3.5" />
          {row.original.nodeCount ?? 0}
        </span>
      ),
      header: "Nodes",
      id: "node-count",
    },
  ];
}

function buildingFloorLabel(room: Room) {
  const parts = [room.building, room.floor].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" / ") : "n/a";
}
