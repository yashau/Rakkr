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
import {
  type AudioInterface,
  type RecorderNode,
  type ScheduleDayOfWeek,
  type ScheduleInput,
  type ScheduleSummary,
} from "@rakkr/shared";

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm-button";
import { ScheduleFiltersPanel } from "@/components/schedule-filters";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  emptySchedulePageFilters,
  scheduleActionState,
  scheduleFiltersFromDraft,
  schedulePageActionPermissions,
  type SchedulePageFilterDraft,
} from "@/lib/schedule-page-helpers";
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
const captureBackends: ScheduleDraft["captureBackend"][] = ["", "alsa", "jack", "pipewire"];

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<ScheduleDraft>(() => defaultDraft());
  const [scheduleFilterDraft, setScheduleFilterDraft] =
    useState<SchedulePageFilterDraft>(emptySchedulePageFilters);
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
  const scheduleFilters = useMemo(
    () => scheduleFiltersFromDraft(scheduleFilterDraft),
    [scheduleFilterDraft],
  );
  const schedulesQuery = useQuery({
    enabled: actionPermissions.canRead,
    queryFn: () => api.schedules(scheduleFilters),
    queryKey: ["schedules", scheduleFilters],
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
    enabled: actionPermissions.canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const nodes = useMemo(() => nodesQuery.data?.data ?? [], [nodesQuery.data?.data]);
  const firstNode = nodes[0];
  const selectedNode = nodes.find((node) => node.id === draft.nodeId);
  const saveScheduleMutation = useMutation({
    mutationFn: ({ input, scheduleId }: { input: ScheduleInput; scheduleId?: string }) =>
      scheduleId ? api.updateSchedule(scheduleId, input) : api.createSchedule(input),
    onError: () =>
      toast.error("Save failed", {
        description: "The schedule could not be saved.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      resetDraft(firstNode);
    },
  });
  const runNowMutation = useMutation({
    mutationFn: api.runScheduleNow,
    onError: () =>
      toast.error("Run failed", {
        description: "The schedule could not be run now.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
    },
  });
  const skipNextMutation = useMutation({
    mutationFn: api.skipScheduleNext,
    onError: () =>
      toast.error("Skip failed", {
        description: "The next scheduled run could not be skipped.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });
  const deleteScheduleMutation = useMutation({
    mutationFn: api.deleteSchedule,
    onError: () =>
      toast.error("Delete failed", {
        description: "The schedule could not be deleted.",
      }),
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
      captureInterfaceId: node?.interfaces.some(
        (candidate) => candidate.id === current.captureInterfaceId,
      )
        ? current.captureInterfaceId
        : "",
      nodeId,
      room: node?.location.room ?? current.room,
    }));
  }

  function setDaysOfWeek(daysOfWeek: ScheduleDayOfWeek[]) {
    setDraft((current) => ({
      ...current,
      daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : current.daysOfWeek,
    }));
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
    return <LoadingSkeleton label="Loading schedules" />;
  }

  if (!actionPermissions.canRead) {
    return (
      <Alert>
        <ShieldCheck className="size-4" />
        <AlertTitle>Schedules</AlertTitle>
        <AlertDescription>Schedules are unavailable.</AlertDescription>
      </Alert>
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
                <Select
                  onValueChange={(value) => selectNode(value === "__all__" ? "" : value)}
                  value={draft.nodeId || "__all__"}
                >
                  <SelectTrigger className={selectClass} id="schedule-node">
                    <SelectValue placeholder="Select a recorder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Select a recorder</SelectItem>
                    {nodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.alias} / {node.location.room}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                <Select
                  onValueChange={(value) =>
                    updateDraft("recurrenceMode", value as ScheduleDraft["recurrenceMode"])
                  }
                  value={draft.recurrenceMode}
                >
                  <SelectTrigger className={selectClass} id="schedule-recurrence-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual next run</SelectItem>
                    <SelectItem value="once">One-off</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="always_on">Always on</SelectItem>
                  </SelectContent>
                </Select>
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
                  <ToggleGroup
                    className="flex flex-wrap justify-start"
                    onValueChange={(values) => setDaysOfWeek(values as ScheduleDayOfWeek[])}
                    type="multiple"
                    value={draft.daysOfWeek}
                    variant="outline"
                  >
                    {dayOptions.map((day) => (
                      <ToggleGroupItem aria-label={day.label} key={day.id} value={day.id}>
                        {day.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              ) : null}

              <div className="flex items-center gap-2 pt-7">
                <Checkbox
                  checked={draft.enabled}
                  id="schedule-enabled"
                  onCheckedChange={(value) => updateDraft("enabled", value === true)}
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

            <div className="grid gap-3 md:grid-cols-6">
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
                <Label htmlFor="schedule-capture-backend">Backend</Label>
                <Select
                  onValueChange={(value) =>
                    updateDraft(
                      "captureBackend",
                      (value === "__all__" ? "" : value) as ScheduleDraft["captureBackend"],
                    )
                  }
                  value={draft.captureBackend || "__all__"}
                >
                  <SelectTrigger className={selectClass} id="schedule-capture-backend">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {captureBackends.map((backend) => (
                      <SelectItem key={backend || "default"} value={backend || "__all__"}>
                        {backend || "Node default"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="schedule-capture-interface">Interface</Label>
                <Select
                  onValueChange={(value) =>
                    updateDraft("captureInterfaceId", value === "__all__" ? "" : value)
                  }
                  value={draft.captureInterfaceId || "__all__"}
                >
                  <SelectTrigger className={selectClass} id="schedule-capture-interface">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Node default</SelectItem>
                    {selectedNode?.interfaces.map((audioInterface) => (
                      <SelectItem key={audioInterface.id} value={audioInterface.id}>
                        {audioInterfaceLabel(audioInterface)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

      <ScheduleFiltersPanel
        filters={scheduleFilterDraft}
        nodes={nodes}
        onChange={setScheduleFilterDraft}
        shownCount={schedules.length}
      />

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
                    <dt className="font-medium text-foreground">Backend</dt>
                    <dd>{schedule.captureBackend ?? "Node default"}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Interface</dt>
                    <dd>{scheduleInterfaceLabel(schedule, nodes)}</dd>
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
                      <ConfirmButton
                        confirmLabel="Delete"
                        description={`This permanently deletes the schedule "${schedule.name}".`}
                        disabled={deleteScheduleMutation.isPending || !actions.canDelete}
                        onConfirm={() => deleteScheduleMutation.mutate(schedule.id)}
                        title={`Delete schedule "${schedule.name}"?`}
                        variant="destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </ConfirmButton>
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

      {schedulesQuery.isLoading ? <LoadingSkeleton label="Loading schedules" /> : null}
      {!schedulesQuery.isLoading && schedules.length === 0 ? (
        <Alert>
          <AlertDescription>No schedules match the current filters.</AlertDescription>
        </Alert>
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

function audioInterfaceLabel(audioInterface: AudioInterface) {
  return `${audioInterface.alias} / ${audioInterface.systemName} / ${audioInterface.backend}`;
}

function scheduleInterfaceLabel(schedule: ScheduleSummary, nodes: RecorderNode[]) {
  if (!schedule.captureInterfaceId) {
    return "Node default";
  }

  const audioInterface = nodes
    .find((node) => node.id === schedule.nodeId)
    ?.interfaces.find((candidate) => candidate.id === schedule.captureInterfaceId);

  return audioInterface ? audioInterfaceLabel(audioInterface) : schedule.captureInterfaceId;
}
