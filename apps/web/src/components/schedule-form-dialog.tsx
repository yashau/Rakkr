import { type FormEvent, useEffect, useState } from "react";
import { PlusCircle, Save, Sparkles, Trash2 } from "lucide-react";
import { type AudioInterface, type RecorderNode, type ScheduleDayOfWeek } from "@rakkr/shared";

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
import {
  addPauseRangeToDraft,
  applyNaturalLanguageSchedule,
  dayOptions,
  removeExceptionFromDraft,
  type ScheduleDraft,
} from "@/lib/schedule-draft";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
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
  const selectedNode = nodes.find((node) => node.id === draft.nodeId);

  // Reset the quick-recurrence helper whenever the dialog opens or closes so a
  // stale phrase never carries between schedules.
  useEffect(() => {
    setQuickRecurrence("");
    setQuickRecurrenceError(false);
  }, [open]);

  function updateDraft<Key extends keyof ScheduleDraft>(key: Key, value: ScheduleDraft[Key]) {
    onDraftChange({ ...draft, [key]: value });
  }

  function selectNode(nodeId: string) {
    const node = nodes.find((candidate) => candidate.id === nodeId);

    onDraftChange({
      ...draft,
      captureInterfaceId: node?.interfaces.some(
        (candidate) => candidate.id === draft.captureInterfaceId,
      )
        ? draft.captureInterfaceId
        : "",
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

            {draft.recurrenceMode !== "manual" && draft.recurrenceMode !== "always_on" ? (
              <div className="grid gap-2">
                <Label htmlFor="schedule-start-early">Start Early Minutes</Label>
                <Input
                  id="schedule-start-early"
                  min={0}
                  onChange={(event) => updateDraft("startEarlyMinutes", Number(event.target.value))}
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
              <Button onClick={() => onDraftChange(addPauseRangeToDraft(draft))} type="button">
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
