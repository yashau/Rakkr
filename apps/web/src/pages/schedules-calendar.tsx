import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, ShieldCheck } from "lucide-react";
import { type ScheduleCalendarOccurrence, type ScheduleInput } from "@rakkr/shared";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { ScheduleFormDialog } from "@/components/schedule-form-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useDocumentTitle } from "@/lib/document-title";
import {
  addMonths,
  buildMonthGrid,
  groupByLocalDay,
  type CalendarDayCell,
  monthGridRange,
  monthLabel,
  moveStartToDay,
  orderedWeekdayLabels,
  timeLabel,
  weekStartIndex,
} from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";
import { nodePickerFilters } from "@/lib/node-page-helpers";
import { schedulePageActionPermissions } from "@/lib/schedule-page-helpers";
import { defaultDraft, draftToInput, type ScheduleDraft } from "@/lib/schedule-draft";

const maxVisibleChips = 3;

interface DragPayload {
  occurrenceStartAt: string;
  recurrenceMode: ScheduleCalendarOccurrence["recurrenceMode"];
  scheduleId: string;
}

export function SchedulesCalendarPage() {
  useDocumentTitle("Schedule Calendar");

  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return { month: now.getMonth(), year: now.getFullYear() };
  });
  const [dragOverIso, setDragOverIso] = useState<string>();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = schedulePageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const controllerSettingsQuery = useQuery({
    queryFn: api.controllerSettings,
    queryKey: ["controller-settings"],
  });
  const weekStartsOn = weekStartIndex(controllerSettingsQuery.data?.data.weekStartsOn);
  const range = useMemo(
    () => monthGridRange(month.year, month.month, weekStartsOn),
    [month.month, month.year, weekStartsOn],
  );
  const calendarQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: () =>
      api.scheduleCalendar({ end: range.end.toISOString(), start: range.start.toISOString() }),
    queryKey: ["schedule-calendar", range.start.toISOString(), range.end.toISOString()],
  });
  const nodesQuery = useQuery({
    enabled: actionPermissions.canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
  });
  const nodes = useMemo(() => nodesQuery.data?.data ?? [], [nodesQuery.data?.data]);
  const firstNode = nodes[0];
  const grid = useMemo(
    () => buildMonthGrid(month.year, month.month, weekStartsOn),
    [month.month, month.year, weekStartsOn],
  );
  const occurrences = useMemo(() => calendarQuery.data?.data ?? [], [calendarQuery.data?.data]);
  const meta = calendarQuery.data?.meta;
  const byDay = useMemo(() => groupByLocalDay(occurrences), [occurrences]);
  const weekdayLabels = orderedWeekdayLabels(weekStartsOn);

  const moveMutation = useMutation({
    mutationFn: ({
      newStartAt,
      occurrenceStartAt,
      scheduleId,
    }: {
      newStartAt: string;
      occurrenceStartAt: string;
      scheduleId: string;
    }) => api.moveScheduleOccurrence(scheduleId, { newStartAt, occurrenceStartAt }),
    onError: () =>
      toast.error("Move failed", {
        description: "The recording could not be moved to that day.",
      }),
    onSuccess: () => {
      toast.success("Recording moved");
      void queryClient.invalidateQueries({ queryKey: ["schedule-calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  const createScheduleMutation = useMutation({
    mutationFn: (input: ScheduleInput) => api.createSchedule(input),
    onError: () =>
      toast.error("Save failed", {
        description: "The schedule could not be created.",
      }),
    onSuccess: () => {
      toast.success("Schedule created");
      void queryClient.invalidateQueries({ queryKey: ["schedule-calendar"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      setCreateDialogOpen(false);
      setDraft(undefined);
    },
  });

  // Seed the create draft with the first available node once nodes load, but
  // never clobber a node the operator already chose.
  useEffect(() => {
    if (!draft || draft.nodeId || !firstNode) {
      return;
    }

    setDraft((current) =>
      current && !current.nodeId
        ? { ...current, nodeId: firstNode.id, room: firstNode.location.room }
        : current,
    );
  }, [draft, firstNode]);

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading calendar" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Schedule calendar</AlertTitle>
        <AlertDescription>The schedule calendar is unavailable.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays className="size-5 text-primary" />
              <h2 className="text-lg font-semibold">Schedule Calendar</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {meta
                ? `${meta.occurrenceCount} occurrences across ${meta.scheduleCount} schedules`
                : "Loading occurrences"}
            </p>
          </div>
          <Button asChild size="sm" type="button" variant="outline">
            <Link to="/schedules">
              <List className="size-4" />
              List view
            </Link>
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setMonth((current) => addMonths(current.year, current.month, -1))}
              size="icon"
              type="button"
              variant="outline"
            >
              <ChevronLeft className="size-4" />
              <span className="sr-only">Previous month</span>
            </Button>
            <Button
              onClick={() => {
                const now = new Date();
                setMonth({ month: now.getMonth(), year: now.getFullYear() });
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Today
            </Button>
            <Button
              onClick={() => setMonth((current) => addMonths(current.year, current.month, 1))}
              size="icon"
              type="button"
              variant="outline"
            >
              <ChevronRight className="size-4" />
              <span className="sr-only">Next month</span>
            </Button>
          </div>
          <h3 className="text-base font-semibold">{monthLabel(month.year, month.month)}</h3>
        </div>

        {meta?.truncated ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing a truncated set of occurrences for this month. Refine filters in list view for
            the full set.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        {calendarQuery.isPending ? (
          <LoadingSkeleton label="Loading occurrences" rows={4} />
        ) : (
          <div className="grid gap-px overflow-hidden rounded-md bg-border">
            <div className="grid grid-cols-7 gap-px bg-border">
              {weekdayLabels.map((label) => (
                <div
                  className="bg-panel px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
                  key={label}
                >
                  {label}
                </div>
              ))}
            </div>
            {grid.map((week) => (
              <div className="grid grid-cols-7 gap-px bg-border" key={week[0].iso}>
                {week.map((cell) => (
                  <DayCell
                    canManage={actionPermissions.canManage}
                    cell={cell}
                    isDragOver={dragOverIso === cell.iso}
                    key={cell.iso}
                    occurrences={byDay.get(cell.iso) ?? []}
                    onClearDragOver={() => setDragOverIso(undefined)}
                    onCreate={() => openCreate(cell)}
                    onDragOver={() => setDragOverIso(cell.iso)}
                    onDrop={(payload) => handleDrop(payload, cell)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      {actionPermissions.canManage && draft ? (
        <ScheduleFormDialog
          draft={draft}
          editing={false}
          nodes={nodes}
          onDraftChange={setDraft}
          onOpenChange={(open) => (open ? setCreateDialogOpen(true) : closeCreate())}
          onSubmit={submitCreate}
          open={createDialogOpen}
          saving={createScheduleMutation.isPending}
        />
      ) : null}
    </div>
  );

  function openCreate(cell: CalendarDayCell) {
    setDraft({
      ...defaultDraft(firstNode),
      recurrenceMode: "once",
      recurrenceStartAt: `${cell.iso}T09:00`,
    });
    setCreateDialogOpen(true);
  }

  function closeCreate() {
    setCreateDialogOpen(false);
    setDraft(undefined);
  }

  function submitCreate() {
    if (!draft) {
      return;
    }

    createScheduleMutation.mutate(draftToInput(draft));
  }

  function handleDrop(payload: DragPayload, cell: CalendarDayCell) {
    setDragOverIso(undefined);

    const newStartAt = moveStartToDay(payload.occurrenceStartAt, cell.iso);

    if (newStartAt === payload.occurrenceStartAt) {
      return;
    }

    moveMutation.mutate({
      newStartAt,
      occurrenceStartAt: payload.occurrenceStartAt,
      scheduleId: payload.scheduleId,
    });
  }
}

function DayCell({
  canManage,
  cell,
  isDragOver,
  occurrences,
  onClearDragOver,
  onCreate,
  onDragOver,
  onDrop,
}: {
  canManage: boolean;
  cell: CalendarDayCell;
  isDragOver: boolean;
  occurrences: ScheduleCalendarOccurrence[];
  onClearDragOver: () => void;
  onCreate: () => void;
  onDragOver: () => void;
  onDrop: (payload: DragPayload) => void;
}) {
  const visible = occurrences.slice(0, maxVisibleChips);
  const hiddenCount = occurrences.length - visible.length;

  return (
    <div
      className={cn(
        "group relative flex min-h-28 flex-col gap-1 bg-panel p-1.5",
        !cell.inMonth && "bg-background/40",
        isDragOver && "-ring-inset ring-2 ring-primary",
      )}
      onDragLeave={onClearDragOver}
      onDragOver={(event) => {
        if (!canManage) {
          return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(event) => {
        if (!canManage) {
          return;
        }

        event.preventDefault();
        const raw = event.dataTransfer.getData("application/json");

        if (!raw) {
          return;
        }

        try {
          onDrop(JSON.parse(raw) as DragPayload);
        } catch {
          onClearDragOver();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-full text-xs font-medium",
            !cell.inMonth && "text-muted-foreground",
            cell.isToday && "bg-primary text-primary-foreground",
          )}
        >
          {cell.date.getDate()}
        </span>
        {canManage && cell.inMonth ? (
          <Button
            className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onCreate}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Plus className="size-3.5" />
            <span className="sr-only">Add schedule on {cell.iso}</span>
          </Button>
        ) : null}
      </div>

      <div className="grid gap-1">
        {visible.map((occurrence) => (
          <OccurrenceChip
            canManage={canManage}
            key={`${occurrence.scheduleId}-${occurrence.recordingStartAt}`}
            occurrence={occurrence}
          />
        ))}
        {hiddenCount > 0 ? (
          <span className="px-1 text-xs text-muted-foreground">+{hiddenCount} more</span>
        ) : null}
      </div>
    </div>
  );
}

function OccurrenceChip({
  canManage,
  occurrence,
}: {
  canManage: boolean;
  occurrence: ScheduleCalendarOccurrence;
}) {
  const chip = (
    <Link
      className={cn(
        "block truncate rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs hover:border-ring",
        !occurrence.enabled && "opacity-60",
      )}
      draggable={canManage}
      onDragStart={(event) => {
        if (!canManage) {
          return;
        }

        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({
            occurrenceStartAt: occurrence.recordingStartAt,
            recurrenceMode: occurrence.recurrenceMode,
            scheduleId: occurrence.scheduleId,
          } satisfies DragPayload),
        );
      }}
      params={{ scheduleId: occurrence.scheduleId }}
      to="/schedules/$scheduleId"
    >
      <span className="font-medium text-foreground">{timeLabel(occurrence.recordingStartAt)}</span>{" "}
      <span className="text-muted-foreground">{occurrence.scheduleName}</span>
    </Link>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>
        <div className="grid gap-0.5 text-xs">
          <span>{occurrence.scheduleName}</span>
          <span>{occurrence.room}</span>
          <Badge className="w-fit" variant={occurrence.enabled ? "secondary" : "outline"}>
            {occurrence.enabled ? "enabled" : "disabled"}
          </Badge>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
