import { type FormEvent, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlusCircle, Save, Sparkles, Trash2 } from "lucide-react";
import {
  defaultStubUploadPolicy,
  type AudioInterface,
  type RecorderNode,
  type ScheduleDayOfWeek,
} from "@rakkr/shared";

import { AssigneeMultiSelect, type AssigneeOption } from "@/components/assignee-multi-select";
import { ChannelSelectionField } from "@/components/channel-selection-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import {
  subjectPickerFilters,
  subjectPickerGroupsQueryKey,
  subjectPickerUsersQueryKey,
} from "@/lib/access-page-helpers";
import {
  addPauseRangeToDraft,
  applyNaturalLanguageSchedule,
  dayOptions,
  removeExceptionFromDraft,
  type ScheduleDraft,
} from "@/lib/schedule-draft";

const selectClass = "w-full";
const captureBackends: ScheduleDraft["captureBackend"][] = ["", "alsa", "jack", "pipewire"];

export function ScheduleFormDialog({
  draft,
  editing,
  nodes,
  onDraftChange,
  onOpenChange,
  onSubmit,
  open,
  saving,
}: {
  draft: ScheduleDraft;
  editing: boolean;
  nodes: RecorderNode[];
  onDraftChange: (draft: ScheduleDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  open: boolean;
  saving: boolean;
}) {
  const [quickRecurrence, setQuickRecurrence] = useState("");
  const [quickRecurrenceError, setQuickRecurrenceError] = useState(false);
  // Advanced settings stay collapsed for the common "add a quick recording"
  // flow; editing an existing schedule opens them so its tuned values are
  // visible without hunting.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selectedNode = nodes.find((node) => node.id === draft.nodeId);
  const recordingProfilesQuery = useQuery({
    enabled: open,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const watchdogPoliciesQuery = useQuery({
    enabled: open,
    queryFn: api.watchdogPolicies,
    queryKey: ["watchdog-policies"],
  });
  const retentionPoliciesQuery = useQuery({
    enabled: open,
    queryFn: api.retentionPolicies,
    queryKey: ["retention-policies"],
  });
  const uploadPoliciesQuery = useQuery({
    enabled: open,
    queryFn: api.uploadPolicies,
    queryKey: ["upload-policies"],
  });
  const recordingProfileOptions = withSelectedOption(
    recordingProfilesQuery.data?.data ?? [],
    draft.recordingProfileId,
  );
  const watchdogPolicyOptions = withSelectedOption(
    watchdogPoliciesQuery.data?.data ?? [],
    draft.watchdogPolicyId,
  );
  const usersQuery = useQuery({
    enabled: open,
    queryFn: () => api.accessUsers(subjectPickerFilters()),
    queryKey: subjectPickerUsersQueryKey(),
  });
  const groupsQuery = useQuery({
    enabled: open,
    queryFn: () => api.accessGroups(subjectPickerFilters()),
    queryKey: subjectPickerGroupsQueryKey(),
  });
  const retentionPolicies = retentionPoliciesQuery.data?.data ?? [];
  // The built-in stub is a test-only queue and never appears in the console.
  const uploadPolicies = (uploadPoliciesQuery.data?.data ?? []).filter(
    (policy) => policy.id !== defaultStubUploadPolicy.id,
  );
  const userOptions: AssigneeOption[] = (usersQuery.data?.data ?? []).map((user) => ({
    id: user.id,
    label: user.name,
    sublabel: user.email,
  }));
  const groupOptions: AssigneeOption[] = (groupsQuery.data?.data ?? []).map((group) => ({
    id: group.id,
    label: group.name,
  }));

  // Reset the quick-recurrence helper whenever the dialog opens or closes so a
  // stale phrase never carries between schedules.
  useEffect(() => {
    setQuickRecurrence("");
    setQuickRecurrenceError(false);
  }, [open]);

  // Collapse advanced options for new schedules; expand them when editing so the
  // existing profile/capture/policy choices are shown up front.
  useEffect(() => {
    setAdvancedOpen(editing);
  }, [editing, open]);

  function updateDraft<Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]) {
    onDraftChange({ ...draft, [key]: value });
  }

  function selectNode(nodeId: string) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const keepsInterface = node?.interfaces.some(
      (candidate) => candidate.id === draft.captureInterfaceId,
    );

    onDraftChange({
      ...draft,
      captureChannels: keepsInterface ? draft.captureChannels : [],
      captureInterfaceId: keepsInterface ? draft.captureInterfaceId : "",
      channelMode: keepsInterface ? draft.channelMode : "",
      nodeId,
      room: node?.location.room ?? draft.room,
    });
  }

  function setDaysOfWeek(daysOfWeek: ScheduleDayOfWeek[]) {
    onDraftChange({
      ...draft,
      daysOfWeek: daysOfWeek.length > 0 ? daysOfWeek : draft.daysOfWeek,
    });
  }

  function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  function applyQuickRecurrence() {
    const nextDraft = applyNaturalLanguageSchedule(draft, quickRecurrence);

    setQuickRecurrenceError(!nextDraft);

    if (nextDraft) {
      onDraftChange(nextDraft);
      setQuickRecurrence("");
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Schedule" : "Create Schedule"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the recurrence, capture, and policy settings for this schedule."
              : "Define a recurring or one-off recording schedule for a recorder node."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" id="schedule-form" onSubmit={submitSchedule}>
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
                  <SelectItem value="once">One-off</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="always_on">Always on</SelectItem>
                  <SelectItem value="manual">Manual next run</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {draft.recurrenceMode === "manual" ? (
              <div className="grid gap-2">
                <Label htmlFor="schedule-next-run">Manual Next Run</Label>
                <DateTimePicker
                  id="schedule-next-run"
                  onChange={(value) => updateDraft("nextRunAt", value)}
                  value={draft.nextRunAt}
                />
              </div>
            ) : null}

            {draft.recurrenceMode === "once" ? (
              <div className="grid gap-2">
                <Label htmlFor="schedule-start-at">Start At</Label>
                <DateTimePicker
                  id="schedule-start-at"
                  onChange={(value) => updateDraft("recurrenceStartAt", value)}
                  required
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
                  multiple
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

            <div className="grid gap-2 md:col-span-2">
              <Label>Assignees</Label>
              <AssigneeMultiSelect
                groupOptions={groupOptions}
                onChange={(next) =>
                  onDraftChange({
                    ...draft,
                    assignedGroupIds: next.groupIds,
                    assignedUserIds: next.userIds,
                  })
                }
                selectedGroupIds={draft.assignedGroupIds}
                selectedUserIds={draft.assignedUserIds}
                userOptions={userOptions}
              />
              <p className="text-xs text-muted-foreground">
                Assigned users and groups get scoped access to this schedule&apos;s room — listen,
                playback, and operating its recordings — without changing their role.
              </p>
            </div>

            <div className="flex items-center gap-2 md:col-span-2">
              <Checkbox
                checked={draft.enabled}
                id="schedule-enabled"
                onCheckedChange={(value) => updateDraft("enabled", value === true)}
              />
              <Label htmlFor="schedule-enabled">Enabled</Label>
            </div>
          </div>

          <div className="border-t border-border">
            <Accordion
              onValueChange={(value) => setAdvancedOpen(value.includes("advanced"))}
              value={advancedOpen ? ["advanced"] : []}
            >
              <AccordionItem className="border-none" value="advanced">
                <AccordionTrigger className="py-3">Advanced options</AccordionTrigger>
                <AccordionContent className="grid gap-4">
                  <div className="grid gap-3 md:grid-cols-2">
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

                    <div className="grid gap-2">
                      <Label htmlFor="schedule-timezone">Timezone</Label>
                      <Input
                        id="schedule-timezone"
                        onChange={(event) => updateDraft("timezone", event.target.value)}
                        required
                        value={draft.timezone}
                      />
                    </div>

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
                          onChange={(event) =>
                            updateDraft("stopLateMinutes", Number(event.target.value))
                          }
                          type="number"
                          value={draft.stopLateMinutes}
                        />
                      </div>
                    ) : null}
                  </div>

                  <div className="grid gap-3">
                    <Label>Paused Date Ranges</Label>
                    <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                      <DatePicker
                        aria-label="Pause start date"
                        onChange={(value) => updateDraft("pauseStartDate", value)}
                        value={draft.pauseStartDate}
                      />
                      <DatePicker
                        aria-label="Pause end date"
                        onChange={(value) => updateDraft("pauseEndDate", value)}
                        value={draft.pauseEndDate}
                      />
                      <Input
                        aria-label="Pause reason"
                        onChange={(event) => updateDraft("pauseReason", event.target.value)}
                        value={draft.pauseReason}
                      />
                      <Button
                        onClick={() => onDraftChange(addPauseRangeToDraft(draft))}
                        type="button"
                      >
                        <PlusCircle className="size-4" />
                        Add Pause
                      </Button>
                    </div>
                    {draft.exceptions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {draft.exceptions.map((exception, index) => (
                          <Button
                            key={`${exception.action}-${exception.action === "skip" ? exception.date : `${exception.startDate}-${exception.endDate}`}`}
                            onClick={() => onDraftChange(removeExceptionFromDraft(draft, index))}
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

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-profile">Recording Profile</Label>
                      <Select
                        onValueChange={(value) => updateDraft("recordingProfileId", value)}
                        value={draft.recordingProfileId}
                      >
                        <SelectTrigger className={selectClass} id="schedule-profile">
                          <SelectValue placeholder="Select a recording profile" />
                        </SelectTrigger>
                        <SelectContent>
                          {recordingProfileOptions.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                          onDraftChange({
                            ...draft,
                            captureChannels: [],
                            captureInterfaceId: value === "__all__" ? "" : value,
                            channelMode: "",
                          })
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
                    <div className="md:col-span-2">
                      <ChannelSelectionField
                        audioInterface={selectedNode?.interfaces.find(
                          (candidate) => candidate.id === draft.captureInterfaceId,
                        )}
                        idPrefix="schedule-capture"
                        onChange={(value) =>
                          onDraftChange({
                            ...draft,
                            captureChannels: value.channels,
                            channelMode: value.mode,
                          })
                        }
                        value={{ channels: draft.captureChannels, mode: draft.channelMode }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-watchdog">Watchdog Policy</Label>
                      <Select
                        onValueChange={(value) => updateDraft("watchdogPolicyId", value)}
                        value={draft.watchdogPolicyId}
                      >
                        <SelectTrigger className={selectClass} id="schedule-watchdog">
                          <SelectValue placeholder="Select a watchdog policy" />
                        </SelectTrigger>
                        <SelectContent>
                          {watchdogPolicyOptions.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {option.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="schedule-retention-policy">Retention Policy</Label>
                      <Select
                        onValueChange={(value) => updateDraft("retentionPolicyId", value)}
                        value={draft.retentionPolicyId}
                      >
                        <SelectTrigger className={selectClass} id="schedule-retention-policy">
                          <SelectValue placeholder="Select a retention policy" />
                        </SelectTrigger>
                        <SelectContent>
                          {retentionPolicies.map((policy) => (
                            <SelectItem key={policy.id} value={policy.id}>
                              {policy.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2 md:col-span-2">
                      <Label>Upload Policies</Label>
                      {uploadPolicies.length > 0 ? (
                        <ToggleGroup
                          className="flex flex-wrap justify-start gap-2"
                          onValueChange={(value) => updateDraft("uploadPolicyIds", value)}
                          multiple
                          value={draft.uploadPolicyIds}
                        >
                          {uploadPolicies.map((policy) => (
                            <ToggleGroupItem
                              className="rounded-md border border-input px-3 data-pressed:border-ring"
                              key={policy.id}
                              value={policy.id}
                            >
                              {policy.name}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No upload policies are configured.
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Each selected policy uploads independently to its destination when a
                        recording is cached.
                      </p>
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
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </form>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={saving} form="schedule-form" type="submit">
            <Save className="size-4" />
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function audioInterfaceLabel(audioInterface: AudioInterface) {
  return `${audioInterface.alias} / ${audioInterface.systemName} / ${audioInterface.backend}`;
}

// Render the fetched profiles/policies as dropdown options, but keep the
// schedule's current selection visible even if it is missing from the list
// (e.g. a renamed template, or settings:read is unavailable to this operator).
function withSelectedOption<Item extends { id: string; name: string }>(
  items: Item[],
  selectedId: string,
) {
  const options = items.map((item) => ({ id: item.id, name: item.name }));

  if (selectedId && !options.some((option) => option.id === selectedId)) {
    return [{ id: selectedId, name: selectedId }, ...options];
  }

  return options;
}
