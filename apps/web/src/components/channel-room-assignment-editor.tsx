import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecorderNode } from "@rakkr/shared";
import { DoorClosed, DoorOpen } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxGroup } from "@/components/searchable-combobox";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

// Room ownership is per-channel: an operator assigns any set of a node's channels
// to a room. Following the roster editor's pattern, channels are rows and a single
// inline combobox assigns the selected rows to a room (or clears them to the node
// default). A channel with no room of its own inherits the node default room.
const NODE_DEFAULT = "__node_default__";

type ChannelAssignment = { channelIndexes: number[]; interfaceId: string; roomId: string | null };

export function NodeChannelRoomEditor({
  canManage,
  node,
}: {
  canManage: boolean;
  node: RecorderNode;
}) {
  const queryClient = useQueryClient();
  const roomsQuery = useQuery({ queryFn: api.rooms, queryKey: ["rooms"] });
  const rooms = useMemo(() => roomsQuery.data?.data ?? [], [roomsQuery.data]);
  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.name])), [rooms]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: (assignments: ChannelAssignment[]) => api.assignChannelRooms(node.id, assignments),
    onError: () =>
      toast.error("Assignment failed", {
        description: "The channel room assignment could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Channel rooms updated");
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  const channelCount = node.interfaces.reduce(
    (total, audioInterface) => total + audioInterface.channels.length,
    0,
  );

  if (channelCount === 0) {
    return null;
  }

  const comboboxGroups: ComboboxGroup[] = [
    { icon: DoorClosed, options: [{ id: NODE_DEFAULT, label: "Node default" }] },
    {
      heading: "Rooms",
      icon: DoorOpen,
      options: rooms.map((room) => ({ id: room.id, keywords: room.id, label: room.name })),
    },
  ];

  return (
    <fieldset
      aria-disabled={!canManage}
      className="grid gap-3 rounded-md border border-border bg-transparent p-3"
      disabled={!canManage}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <DoorOpen className="size-4" />
        Channel Rooms
      </div>
      <p className="text-xs text-muted-foreground">
        Select channels, then assign them to a room. Channels left on “Node default” inherit{" "}
        {node.roomId ? "the node’s room" : "no room"}.
      </p>

      <div className="grid gap-3">
        {node.interfaces.map((audioInterface) => {
          const keys = audioInterface.channels.map((channel) =>
            channelKey(audioInterface.id, channel.index),
          );
          const allSelected = keys.length > 0 && keys.every((key) => selected.has(key));

          return (
            <div className="grid gap-1.5" key={audioInterface.id}>
              <div className="flex items-center gap-2">
                <Checkbox
                  aria-label={`Select all channels on ${audioInterface.alias}`}
                  checked={allSelected}
                  disabled={!canManage}
                  onCheckedChange={() => toggleMany(keys, !allSelected)}
                />
                <Label className="text-xs text-muted-foreground">{audioInterface.alias}</Label>
              </div>
              <div className="grid max-h-72 gap-1.5 overflow-auto pr-1">
                {audioInterface.channels.map((channel) => {
                  const key = channelKey(audioInterface.id, channel.index);

                  return (
                    <label
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-transparent p-2 text-sm has-[:checked]:border-ring has-[:checked]:bg-muted/40"
                      key={key}
                    >
                      <Checkbox
                        aria-label={`Select channel ${channel.index}`}
                        checked={selected.has(key)}
                        disabled={!canManage}
                        onCheckedChange={() => toggleMany([key], !selected.has(key))}
                      />
                      <Badge className="justify-center tabular-nums" variant="outline">
                        {channel.index}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">{channel.alias}</span>
                      {channel.roomId ? (
                        <Badge className="gap-1" variant="secondary">
                          <DoorOpen className="size-3" />
                          {roomNames.get(channel.roomId) ?? channel.roomId}
                        </Badge>
                      ) : (
                        <Badge className="gap-1 text-muted-foreground" variant="outline">
                          <DoorClosed className="size-3" />
                          Node default
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">
          {selected.size > 0
            ? `Assign ${selected.size} selected channel${selected.size === 1 ? "" : "s"} to…`
            : "Select channels to assign a room"}
        </Label>
        <Combobox
          ariaLabel="Assign selected channels to a room"
          closeOnSelect
          disabled={!canManage || selected.size === 0 || mutation.isPending}
          emptyText="No rooms found."
          groups={comboboxGroups}
          onSelect={(option) => assignSelected(option.id === NODE_DEFAULT ? null : option.id)}
          placeholder="Assign selected channels to a room…"
        />
      </div>
      {mutation.isError ? (
        <p className="text-sm text-destructive">Channel room assignment failed.</p>
      ) : null}
    </fieldset>
  );

  function toggleMany(keys: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);

      for (const key of keys) {
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }

      return next;
    });
  }

  function assignSelected(roomId: string | null) {
    const byInterface = new Map<string, number[]>();

    for (const key of selected) {
      const [interfaceId, index] = splitKey(key);
      byInterface.set(interfaceId, [...(byInterface.get(interfaceId) ?? []), index]);
    }

    const assignments: ChannelAssignment[] = [...byInterface.entries()].map(
      ([interfaceId, channelIndexes]) => ({ channelIndexes, interfaceId, roomId }),
    );

    if (assignments.length > 0) {
      mutation.mutate(assignments);
    }
  }
}

function channelKey(interfaceId: string, channelIndex: number) {
  return `${interfaceId}::${channelIndex}`;
}

function splitKey(key: string): [string, number] {
  const separator = key.lastIndexOf("::");

  return [key.slice(0, separator), Number(key.slice(separator + 2))];
}
