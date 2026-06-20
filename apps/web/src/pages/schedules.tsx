import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  CalendarPlus,
  FileSearch,
  Pencil,
  PlusCircle,
  Repeat2,
  RotateCcw,
  Save,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Trash2,
} from "lucide-react";
import { type ScheduleDayOfWeek, type ScheduleInput, type ScheduleSummary } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { scheduleActionState, schedulePageActionPermissions } from "@/lib/schedule-page-helpers";
import {
  addPauseRangeToDraft,
  applyNaturalLanguageSchedule,
  bufferSummary,
  dayOptions,
  defaultDraft,
  draftToInput,
  exceptionSummary,
  occurrenceWindow,
  recurrenceSummary,
  removeExceptionFromDraft,
  scheduleTimelineEvents,
  scheduleToDraft,
  timelineAction,
  type ScheduleDraft,
} from "@/lib/schedule-draft";
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<ScheduleDraft>(() => defaultDraft());
  const [quickRecurrence, setQuickRecurrence] = useState("");
  const [quickRecurrenceError, setQuickRecurrenceError] = useState(false);
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const actionPermissions = schedulePageActionPermissions(
    currentUserQuery.data?.data.permissions ?? [],
  );
  const schedulesQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: api.schedules,
    queryKey: ["schedules"],
  });
  const schedules = useMemo(() => schedulesQuery.data?.data ?? [], [schedulesQuery.data?.data]);
  const occurrenceQueries = useQueries({
    queries: schedules.map((schedule) => ({
      enabled: actionPermissions.canRead,
      queryFn: () => api.scheduleOccurrences(schedule.id, 4),
      queryKey: ["schedule-occurrences", schedule.id],
      refetchInterval: 5000,
    })),
  });
  const occurrencesBySchedule = useMemo(
    () =>
      new Map(
        schedules.map((schedule, index) => [
          schedule.id,
          occurrenceQueries[index]?.data?.data ?? [],
        ]),
      ),
    [occurrenceQueries, schedules],
  );
  const scheduleAuditQuery = useQuery({
    enabled: actionPermissions.canReadAudit,
    queryFn: () => api.auditEvents({ action: "schedules.", limit: 100 }),
    queryKey: ["audit-events", "schedules-timeline"],
    refetchInterval: 5000,
  });
  const scheduleAuditEvents = scheduleAuditQuery.data?.data ?? [];
  const nodesQuery = useQuery({
    enabled: actionPermissions.canManage && actionPermissions.canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const nodes = useMemo(() => nodesQuery.data?.data ?? [], [nodesQuery.data?.data]);
  const firstNode = nodes[0];
  const saveScheduleMutation = useMutation({
    mutationFn: ({ input, scheduleId }: { input: ScheduleInput; scheduleId?: string }) =>
      scheduleId ? api.updateSchedule(scheduleId, input) : api.createSchedule(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      resetDraft(firstNode);
    },
  });
  const runNowMutation = useMutation({
    mutationFn: api.runScheduleNow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
    },
  });
  const skipNextMutation = useMutation({
    mutationFn: api.skipScheduleNext,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });
  const deleteScheduleMutation = useMutation({
    mutationFn: api.deleteSchedule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setEditingId(undefined);
      resetDraft(firstNode);
    },
  });

  useEffect(() => {
    if (draft.nodeId || !firstNode) {
      return;
    }

    setDraft((current) =>
      current.nodeId
        ? current
        : {
            ...current,
            nodeId: firstNode.id,
            room: firstNode.location.room,
          },
    );
  }, [draft.nodeId, firstNode]);

  function resetDraft(node = firstNode) {
    setEditingId(undefined);
    setDraft(defaultDraft(node));
  }

  function editSchedule(schedule: ScheduleSummary) {
    setEditingId(schedule.id);
    setDraft(scheduleToDraft(schedule));
  }

  function updateDraft<Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function selectNode(nodeId: string) {
    const node = nodes.find((candidate) => candidate.id === nodeId);

    setDraft((current) => ({
      ...current,
      nodeId,
      room: node?.location.room ?? current.room,
    }));
  }

  function toggleDay(day: ScheduleDayOfWeek) {
    setDraft((current) => {
      const isSelected = current.daysOfWeek.includes(day);
      const daysOfWeek = isSelected
        ? current.daysOfWeek.filter((candidate) => candidate !== day)
        : [...current.daysOfWeek, day];

      return {
        ...current,
        daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : current.daysOfWeek,
      };
    });
  }

  function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveScheduleMutation.mutate({
      input: draftToInput(draft),
      scheduleId: editingId,
    });
  }

  function applyQuickRecurrence() {
    const nextDraft = applyNaturalLanguageSchedule(draft, quickRecurrence);

    setQuickRecurrenceError(!nextDraft);

    if (nextDraft) {
      setDraft(nextDraft);
      setQuickRecurrence("");
    }
  }

  if (currentUserQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading schedules.</p>;
  }

  if (!actionPermissions.canRead) {
    return (
      <Card className="rounded-lg p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Schedules</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Schedules are unavailable.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {actionPermissions.canManage ? (
        <Card className="rounded-lg p-4 shadow-sm">
          <form className="grid gap-4" onSubmit={submitSchedule}>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                {editingId ? (
                  <Pencil className="size-5 text-teal-700" />
                ) : (
                  <PlusCircle className="size-5 text-teal-700" />
                )}
                <h2 className="text-base font-semibold">
                  {editingId ? "Edit Schedule" : "Create Schedule"}
                </h2>
                {editingId ? <Badge variant="outline">{editingId}</Badge> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saveScheduleMutation.isPending}>
                  <Save className="size-4" />
                  {editingId ? "Save" : "Create"}
                </Button>
                <Button onClick={() => resetDraft()} type="button" variant="outline">
                  <RotateCcw className="size-4" />
                  Reset
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="schedule-name">Name</Label>
                <Input
                  id="schedule-name"
                  onChange={(event) => updateDraft("name", event.target.value)}
                  required
                  value={draft.name}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule-node">Recorder Node</Label>
                <select
                  className={selectClass}
                  id="schedule-node"
                  onChange={(event) => selectNode(event.target.value)}
                  required
                  value={draft.nodeId}
                >
                  <option value="">Select a recorder</option>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.alias} / {node.location.room}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule-room">Room</Label>
                <Input
                  id="schedule-room"
                  onChange={(event) => updateDraft("room", event.target.value)}
                  required
                  value={draft.room}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule-timezone">Timezone</Label>
                <Input
                  id="schedule-timezone"
                  onChange={(event) => updateDraft("timezone", event.target.value)}
                  required
                  value={draft.timezone}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule-recurrence-mode">Recurrence</Label>
                <select
                  className={selectClass}
                  id="schedule-recurrence-mode"
                  onChange={(event) =>
                    updateDraft(
                      "recurrenceMode",
                      event.target.value as ScheduleDraft["recurrenceMode"],
                    )
                  }
                  value={draft.recurrenceMode}
                >
                  <option value="manual">Manual next run</option>
                  <option value="once">One-off</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="always_on">Always on</option>
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule-quick-recurrence">Quick Recurrence</Label>
                <div className="flex gap-2">
                  <Input
                    aria-invalid={quickRecurrenceError}
                    id="schedule-quick-recurrence"
                    onChange={(event) => {
                      setQuickRecurrence(event.target.value);
                      setQuickRecurrenceError(false);
                    }}
                    placeholder="weekdays 9am-10am"
                    value={quickRecurrence}
                  />
                  <Button onClick={applyQuickRecurrence} type="button" variant="outline">
                    <Sparkles className="size-4" />
                    Apply
                  </Button>
                </div>
              </div>

              {draft.recurrenceMode === "manual" ? (
                <div className="grid gap-2">
                  <Label htmlFor="schedule-next-run">Manual Next Run</Label>
                  <Input
                    id="schedule-next-run"
                    onChange={(event) => updateDraft("nextRunAt", event.target.value)}
                    type="datetime-local"
                    value={draft.nextRunAt}
                  />
                </div>
              ) : null}

              {draft.recurrenceMode === "once" ? (
                <div className="grid gap-2">
                  <Label htmlFor="schedule-start-at">Start At</Label>
                  <Input
                    id="schedule-start-at"
                    onChange={(event) => updateDraft("recurrenceStartAt", event.target.value)}
                    required
                    type="datetime-local"
                    value={draft.recurrenceStartAt}
                  />
                </div>
              ) : null}

              {["daily", "weekly", "monthly"].includes(draft.recurrenceMode) ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-start-time">Start Time</Label>
                    <Input
                      id="schedule-start-time"
                      onChange={(event) => updateDraft("startTime", event.target.value)}
                      required
                      type="time"
                      value={draft.startTime}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-end-time">End Time</Label>
                    <Input
                      id="schedule-end-time"
                      onChange={(event) => updateDraft("endTime", event.target.value)}
                      required
                      type="time"
                      value={draft.endTime}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="schedule-interval">Every</Label>
                    <Input
                      id="schedule-interval"
                      min={1}
                      onChange={(event) => updateDraft("interval", Number(event.target.value))}
                      required
                      type="number"
                      value={draft.interval}
                    />
                  </div>
                </>
              ) : null}

              {draft.recurrenceMode !== "manual" && draft.recurrenceMode !== "always_on" ? (
                <div className="grid gap-2">
                  <Label htmlFor="schedule-start-early">Start Early Minutes</Label>
                  <Input
                    id="schedule-start-early"
                    min={0}
                    onChange={(event) =>
                      updateDraft("startEarlyMinutes", Number(event.target.value))
                    }
                    type="number"
                    value={draft.startEarlyMinutes}
                  />
                </div>
              ) : null}

              {["daily", "weekly", "monthly"].includes(draft.recurrenceMode) ? (
                <div className="grid gap-2">
                  <Label htmlFor="schedule-stop-late">Stop Late Minutes</Label>
                  <Input
                    id="schedule-stop-late"
                    min={0}
                    onChange={(event) => updateDraft("stopLateMinutes", Number(event.target.value))}
                    type="number"
                    value={draft.stopLateMinutes}
                  />
                </div>
              ) : null}

              {draft.recurrenceMode === "monthly" ? (
                <div className="grid gap-2">
                  <Label htmlFor="schedule-day-of-month">Day Of Month</Label>
                  <Input
                    id="schedule-day-of-month"
                    max={31}
                    min={1}
                    onChange={(event) => updateDraft("dayOfMonth", Number(event.target.value))}
                    required
                    type="number"
                    value={draft.dayOfMonth}
                  />
                </div>
              ) : null}

              {draft.recurrenceMode === "weekly" ? (
                <div className="grid gap-2 md:col-span-2">
                  <Label>Days Of Week</Label>
                  <div className="flex flex-wrap gap-2">
                    {dayOptions.map((day) => {
                      const selected = draft.daysOfWeek.includes(day.id);

                      return (
                        <Button
                          aria-pressed={selected}
                          key={day.id}
                          onClick={() => toggleDay(day.id)}
                          type="button"
                          variant={selected ? "default" : "outline"}
                        >
                          {day.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="flex items-center gap-2 pt-7">
                <Input
                  checked={draft.enabled}
                  className="size-4 accent-teal-700"
                  id="schedule-enabled"
                  onChange={(event) => updateDraft("enabled", event.target.checked)}
                  type="checkbox"
                />
                <Label htmlFor="schedule-enabled">Enabled</Label>
              </div>
            </div>

            <div className="grid gap-3">
              <Label>Paused Date Ranges</Label>
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                <Input
                  aria-label="Pause start date"
                  onChange={(event) => updateDraft("pauseStartDate", event.target.value)}
                  type="date"
                  value={draft.pauseStartDate}
                />
                <Input
                  aria-label="Pause end date"
                  onChange={(event) => updateDraft("pauseEndDate", event.target.value)}
                  type="date"
                  value={draft.pauseEndDate}
                />
                <Input
                  aria-label="Pause reason"
                  onChange={(event) => updateDraft("pauseReason", event.target.value)}
                  value={draft.pauseReason}
                />
                <Button onClick={() => setDraft(addPauseRangeToDraft(draft))} type="button">
                  <PlusCircle className="size-4" />
                  Add Pause
                </Button>
              </div>
              {draft.exceptions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {draft.exceptions.map((exception, index) => (
                    <Button
                      key={`${exception.action}-${exception.action === "skip" ? exception.date : `${exception.startDate}-${exception.endDate}`}`}
                      onClick={() => setDraft(removeExceptionFromDraft(draft, index))}
                      type="button"
                      variant="outline"
                    >
                      <Trash2 className="size-3" />
                      {exception.action === "skip"
                        ? `Skip ${exception.date}`
                        : `Pause ${exception.startDate}-${exception.endDate}`}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="schedule-title-template">Title Template</Label>
                <Textarea
                  id="schedule-title-template"
                  onChange={(event) => updateDraft("titleTemplate", event.target.value)}
                  required
                  value={draft.titleTemplate}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-folder-template">Folder Template</Label>
                <Textarea
                  id="schedule-folder-template"
                  onChange={(event) => updateDraft("folderTemplate", event.target.value)}
                  required
                  value={draft.folderTemplate}
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-5">
              <div className="grid gap-2">
                <Label htmlFor="schedule-profile">Recording Profile</Label>
                <Input
                  id="schedule-profile"
                  onChange={(event) => updateDraft("recordingProfileId", event.target.value)}
                  required
                  value={draft.recordingProfileId}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-watchdog">Watchdog Policy</Label>
                <Input
                  id="schedule-watchdog"
                  onChange={(event) => updateDraft("watchdogPolicyId", event.target.value)}
                  required
                  value={draft.watchdogPolicyId}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-upload-policy">Upload Policy</Label>
                <Input
                  id="schedule-upload-policy"
                  onChange={(event) => updateDraft("uploadPolicyId", event.target.value)}
                  required
                  value={draft.uploadPolicyId}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-retention-policy">Retention Policy</Label>
                <Input
                  id="schedule-retention-policy"
                  onChange={(event) => updateDraft("retentionPolicyId", event.target.value)}
                  required
                  value={draft.retentionPolicyId}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-tags">Tags</Label>
                <Input
                  id="schedule-tags"
                  onChange={(event) => updateDraft("tags", event.target.value)}
                  value={draft.tags}
                />
              </div>
            </div>
          </form>
        </Card>
      ) : null}

      {schedules.map((schedule) => {
        const actions = scheduleActionState(schedule, actionPermissions);
        const occurrences = occurrencesBySchedule.get(schedule.id) ?? [];
        const timelineEvents = scheduleTimelineEvents(schedule.id, scheduleAuditEvents);

        return (
          <Card className="rounded-lg p-4 shadow-sm" key={schedule.id}>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <CalendarClock className="size-5 text-teal-700" />
                  <h2 className="text-base font-semibold">{schedule.name}</h2>
                  <Badge variant={schedule.enabled ? "secondary" : "outline"}>
                    {schedule.enabled ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {schedule.room} / {schedule.timezone}
                </p>
                <div className="mt-1 flex items-center gap-2 text-sm">
                  <Repeat2 className="size-4 text-teal-700" />
                  <span>{recurrenceSummary(schedule.recurrence)}</span>
                </div>
                {schedule.nextRunAt ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Next: {formatDateTime(schedule.nextRunAt)}
                  </p>
                ) : null}
                <dl className="mt-3 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                  <div>
                    <dt className="font-medium text-foreground">Title</dt>
                    <dd>{schedule.titleTemplate}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Folder</dt>
                    <dd>{schedule.folderTemplate}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Profile</dt>
                    <dd>{schedule.recordingProfileId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Watchdog</dt>
                    <dd>{schedule.watchdogPolicyId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Upload Policy</dt>
                    <dd>{schedule.uploadPolicyId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Retention Policy</dt>
                    <dd>{schedule.retentionPolicyId}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Buffers</dt>
                    <dd>{bufferSummary(schedule.recurrence)}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Skipped Dates</dt>
                    <dd>{exceptionSummary(schedule.recurrence)}</dd>
                  </div>
                </dl>
                <div className="mt-4 grid gap-4 text-xs md:grid-cols-2">
                  <div className="grid gap-2">
                    <h3 className="font-medium text-foreground">Upcoming Runs</h3>
                    <ol className="grid gap-2 border-l border-border pl-3 text-muted-foreground">
                      {occurrences.length > 0 ? (
                        occurrences.map((occurrence) => (
                          <li key={occurrence.recordingStartAt}>
                            <div className="font-medium text-foreground">
                              {formatDateTime(occurrence.recordingStartAt)}
                            </div>
                            <div>{occurrenceWindow(occurrence)}</div>
                          </li>
                        ))
                      ) : (
                        <li>No scheduled occurrences.</li>
                      )}
                    </ol>
                  </div>
                  <div className="grid gap-2">
                    <h3 className="font-medium text-foreground">Recent Timeline</h3>
                    <ol className="grid gap-2 border-l border-border pl-3 text-muted-foreground">
                      {timelineEvents.length > 0 ? (
                        timelineEvents.map((event) => (
                          <li key={event.id}>
                            <div className="font-mono text-foreground">{timelineAction(event)}</div>
                            <div>
                              {formatDateTime(event.createdAt)} / {event.outcome}
                            </div>
                          </li>
                        ))
                      ) : (
                        <li>No recent schedule events.</li>
                      )}
                    </ol>
                  </div>
                </div>
              </div>
              <div className="grid gap-3 md:justify-items-end">
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <Button asChild type="button" variant="outline">
                    <Link params={{ scheduleId: schedule.id }} to="/schedules/$scheduleId">
                      <FileSearch className="size-4" />
                      Details
                    </Link>
                  </Button>
                  {actions.canEdit ? (
                    <Button onClick={() => editSchedule(schedule)} type="button" variant="outline">
                      <Pencil className="size-4" />
                      Edit
                    </Button>
                  ) : null}
                  {actionPermissions.canManage ? (
                    <>
                      <Button
                        disabled={runNowMutation.isPending || !actions.canRunNow}
                        onClick={() => runNowMutation.mutate(schedule.id)}
                        type="button"
                        variant="outline"
                      >
                        <CalendarPlus className="size-4" />
                        Run Now
                      </Button>
                      <Button
                        disabled={skipNextMutation.isPending || !actions.canSkipNext}
                        onClick={() => skipNextMutation.mutate(schedule.id)}
                        type="button"
                        variant="outline"
                      >
                        <SkipForward className="size-4" />
                        Skip Next
                      </Button>
                      <Button
                        disabled={deleteScheduleMutation.isPending || !actions.canDelete}
                        onClick={() => {
                          if (window.confirm(`Delete schedule "${schedule.name}"?`)) {
                            deleteScheduleMutation.mutate(schedule.id);
                          }
                        }}
                        type="button"
                        variant="outline"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {schedule.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        );
      })}

      {schedulesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading schedules.</p>
      ) : null}
      {saveScheduleMutation.isError ? (
        <p className="text-sm text-destructive">Schedule save failed.</p>
      ) : null}
      {runNowMutation.isError ? (
        <p className="text-sm text-destructive">Schedule run failed.</p>
      ) : null}
      {skipNextMutation.isError ? (
        <p className="text-sm text-destructive">Schedule skip failed.</p>
      ) : null}
      {deleteScheduleMutation.isError ? (
        <p className="text-sm text-destructive">Schedule delete failed.</p>
      ) : null}
    </div>
  );
}
