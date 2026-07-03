import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecorderNode } from "@rakkr/shared";
import { DoorOpen, Save } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

// Room ownership is per-channel: an operator assigns any set of a node's channels
// to a room. This editor exposes that as a per-channel room picker plus a
// multi-select bulk "assign selected -> room" action. A channel with no room of
// its own inherits the node default room.
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
  const rooms = roomsQuery.data?.data ?? [];
  const roomNames = useMemo(
    () => new Map(rooms.map((room) => [room.id, room.name])),
    [rooms],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRoomId, setBulkRoomId] = useState<string>(NODE_DEFAULT);

  const mutation = useMutation({
    mutationFn: (assignments: ChannelAssignment[]) => api.assignChannelRooms(node.id, assignments),
    onError: () =>
      toast.error("Assignment failed", {
        description: "The channel room assignment could not be saved.",
      }),
    onSuccess: () => {
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

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  function assignOne(interfaceId: string, channelIndex: number, value: string) {
    mutation.mutate([
      { channelIndexes: [channelIndex], interfaceId, roomId: value === NODE_DEFAULT ? null : value },
    ]);
  }

  function assignSelected() {
    const byInterface = new Map<string, number[]>();

    for (const key of selected) {
      const [interfaceId, index] = splitKey(key);
      byInterface.set(interfaceId, [...(byInterface.get(interfaceId) ?? []), index]);
    }

    const assignments: ChannelAssignment[] = [...byInterface.entries()].map(
      ([interfaceId, channelIndexes]) => ({
        channelIndexes,
        interfaceId,
        roomId: bulkRoomId === NODE_DEFAULT ? null : bulkRoomId,
      }),
    );

    if (assignments.length > 0) {
      mutation.mutate(assignments);
    }
  }

  return (
    <fieldset
      aria-disabled={!canManage}
      className="grid gap-3 rounded-md border border-border bg-background p-3"
      disabled={!canManage}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <DoorOpen className="size-4" />
        Channel Rooms
      </div>
      <p className="text-xs text-muted-foreground">
        Assign each channel to the room it records. Channels left as “Node default” inherit{" "}
        {node.roomId ? "the node’s room" : "no room"}.
      </p>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
          <span className="text-xs font-medium">{selected.size} selected</span>
          <Select onValueChange={setBulkRoomId} value={bulkRoomId}>
            <SelectTrigger className="h-8 w-48 px-2 py-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NODE_DEFAULT}>Node default</SelectItem>
              {rooms.map((room) => (
                <SelectItem key={room.id} value={room.id}>
                  {room.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={mutation.isPending || !canManage}
            onClick={assignSelected}
            size="sm"
            type="button"
          >
            <Save className="size-4" />
            Assign selected
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3">
        {node.interfaces.map((audioInterface) => (
          <div className="grid gap-1.5" key={audioInterface.id}>
            <Label className="text-xs text-muted-foreground">{audioInterface.alias}</Label>
            <div className="grid max-h-72 gap-1.5 overflow-auto pr-1">
              {audioInterface.channels.map((channel) => {
                const key = channelKey(audioInterface.id, channel.index);

                return (
                  <div
                    className="grid grid-cols-[1.5rem_2.5rem_1fr_11rem] items-center gap-2"
                    key={key}
                  >
                    <Checkbox
                      aria-label={`Select channel ${channel.index}`}
                      checked={selected.has(key)}
                      disabled={!canManage}
                      onCheckedChange={() => toggle(key)}
                    />
                    <Badge className="justify-center tabular-nums" variant="outline">
                      {channel.index}
                    </Badge>
                    <span className="truncate text-xs">{channel.alias}</span>
                    <Select
                      disabled={!canManage || mutation.isPending}
                      onValueChange={(value) => assignOne(audioInterface.id, channel.index, value)}
                      value={channel.roomId ?? NODE_DEFAULT}
                    >
                      <SelectTrigger className="h-8 px-2 py-1 text-xs">
                        <SelectValue>
                          {channel.roomId
                            ? (roomNames.get(channel.roomId) ?? channel.roomId)
                            : "Node default"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NODE_DEFAULT}>Node default</SelectItem>
                        {rooms.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {mutation.isError ? (
        <p className="text-sm text-destructive">Channel room assignment failed.</p>
      ) : null}
    </fieldset>
  );
}

function channelKey(interfaceId: string, channelIndex: number) {
  return `${interfaceId}::${channelIndex}`;
}

function splitKey(key: string): [string, number] {
  const separator = key.lastIndexOf("::");

  return [key.slice(0, separator), Number(key.slice(separator + 2))];
}
