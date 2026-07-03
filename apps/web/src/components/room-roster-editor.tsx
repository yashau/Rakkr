import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Save, Users, UserRound, X } from "lucide-react";
import { roomCapabilities, type RoomCapability, type RoomRosterEntry } from "@rakkr/shared";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxGroup } from "@/components/searchable-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";

interface ManualEntryDraft {
  capabilities: RoomCapability[];
  subjectId: string;
  subjectName: string;
  subjectType: "group" | "user";
}

export function RoomRosterEditor({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const [manualEntries, setManualEntries] = useState<ManualEntryDraft[]>();
  const [addOpen, setAddOpen] = useState(false);
  const rosterQuery = useQuery({
    queryFn: () => api.roomRoster(roomId),
    queryKey: ["room-roster", roomId],
  });
  const usersQuery = useQuery({
    enabled: addOpen,
    queryFn: () => api.accessUsers({ limit: 500 }),
    queryKey: ["access-users"],
  });
  const groupsQuery = useQuery({
    enabled: addOpen,
    queryFn: () => api.accessGroups(),
    queryKey: ["access-groups"],
  });
  const saveMutation = useMutation({
    mutationFn: (entries: ManualEntryDraft[]) =>
      api.updateRoomRoster(roomId, {
        entries: entries.map((entry) => ({
          capabilities: entry.capabilities,
          subjectId: entry.subjectId,
          subjectType: entry.subjectType,
        })),
      }),
    onError: () =>
      toast.error("Save failed", {
        description: "The room roster could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Roster saved");
      void queryClient.invalidateQueries({ queryKey: ["room-roster", roomId] });
    },
  });

  const calendarEntries = (rosterQuery.data?.data ?? []).filter(
    (entry) => entry.source === "calendar",
  );

  // Seed the editable draft from the fetched roster once, then let local edits
  // own the state until the operator saves (matches the settings-page pattern
  // of draft-plus-mutation rather than re-deriving from every refetch).
  useEffect(() => {
    if (manualEntries !== undefined || !rosterQuery.data) {
      return;
    }

    setManualEntries(manualEntryDraftsFromRoster(rosterQuery.data.data));
  }, [manualEntries, rosterQuery.data]);

  if (rosterQuery.isPending || manualEntries === undefined) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const usedSubjectIds = new Set(manualEntries.map((entry) => entry.subjectId));
  const userOptions = (usersQuery.data?.data ?? []).filter((user) => !usedSubjectIds.has(user.id));
  const groupOptions = (groupsQuery.data?.data ?? []).filter(
    (group) => !usedSubjectIds.has(group.id),
  );

  const comboboxGroups: ComboboxGroup[] = [
    {
      heading: "Access groups",
      icon: Users,
      options: groupOptions.map((group) => ({
        id: `group:${group.id}`,
        keywords: group.id,
        label: group.name,
      })),
    },
    {
      heading: "Users",
      icon: UserRound,
      options: userOptions.map((user) => ({
        id: `user:${user.id}`,
        keywords: user.email,
        label: user.name,
        sublabel: user.email,
      })),
    },
  ];

  return (
    <div className="grid gap-3">
      {calendarEntries.length > 0 ? (
        <div className="grid gap-2">
          {calendarEntries.map((entry) => (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-transparent p-3 text-sm"
              key={`calendar-${entry.subjectType}-${entry.subjectId}`}
            >
              <SubjectBadge type={entry.subjectType} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {entry.subjectName ?? entry.subjectId}
              </span>
              <Badge className="gap-1" variant="outline">
                <Calendar className="size-3" />
                from calendar
              </Badge>
              <div className="flex flex-wrap gap-1">
                {entry.capabilities.map((capability) => (
                  <Badge key={capability} variant="secondary">
                    {capitalize(capability)}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-2">
        {manualEntries.map((entry) => (
          <div
            className="grid gap-2 rounded-md border border-border bg-transparent p-3"
            key={`manual-${entry.subjectType}-${entry.subjectId}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <SubjectBadge type={entry.subjectType} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {entry.subjectName}
              </span>
              <Button
                aria-label={`Remove ${entry.subjectName}`}
                onClick={() => removeEntry(entry.subjectId)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>
            <ToggleGroup
              className="flex flex-wrap justify-start gap-1"
              onValueChange={(values) =>
                setCapabilities(entry.subjectId, values as RoomCapability[])
              }
              multiple
              value={entry.capabilities}
              variant="outline"
            >
              {roomCapabilities.map((capability) => (
                <ToggleGroupItem
                  aria-label={capitalize(capability)}
                  key={capability}
                  value={capability}
                >
                  {capitalize(capability)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        ))}
        {manualEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No manual roster entries yet.</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Combobox
          ariaLabel="Add a user or group to the roster"
          closeOnSelect
          emptyText="No users or groups found."
          groups={comboboxGroups}
          onOpenChange={setAddOpen}
          onSelect={(option) => {
            const separator = option.id.indexOf(":");
            const kind = option.id.slice(0, separator) as "group" | "user";
            addEntry({ id: option.id.slice(separator + 1), name: option.label, type: kind });
          }}
          placeholder="Add a user or group…"
        />
        <div className="flex justify-end">
          <Button
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(manualEntries)}
          >
            <Save className="size-4" />
            Save roster
          </Button>
        </div>
      </div>
    </div>
  );

  function addEntry(subject: { id: string; name: string; type: "group" | "user" }) {
    setManualEntries((current) => [
      ...(current ?? []),
      {
        capabilities: [],
        subjectId: subject.id,
        subjectName: subject.name,
        subjectType: subject.type,
      },
    ]);
    setAddOpen(false);
  }

  function removeEntry(subjectId: string) {
    setManualEntries((current) => (current ?? []).filter((entry) => entry.subjectId !== subjectId));
  }

  function setCapabilities(subjectId: string, capabilities: RoomCapability[]) {
    setManualEntries((current) =>
      (current ?? []).map((entry) =>
        entry.subjectId === subjectId ? { ...entry, capabilities } : entry,
      ),
    );
  }
}

function manualEntryDraftsFromRoster(entries: RoomRosterEntry[]): ManualEntryDraft[] {
  return entries
    .filter((entry) => entry.source === "manual")
    .map((entry) => ({
      capabilities: [...entry.capabilities],
      subjectId: entry.subjectId,
      subjectName: entry.subjectName ?? entry.subjectId,
      subjectType: entry.subjectType,
    }));
}

function SubjectBadge({ type }: { type: "group" | "user" }) {
  return (
    <Badge className="gap-1 bg-transparent" variant="outline">
      {type === "group" ? <Users className="size-3" /> : <UserRound className="size-3" />}
      {type}
    </Badge>
  );
}

function capitalize(value: string) {
  return value.length > 0 ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
