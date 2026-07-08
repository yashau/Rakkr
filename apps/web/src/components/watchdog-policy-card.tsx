import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  defaultScheduledVoiceWatchdogPolicy,
  type RecorderNode,
  type WatchdogPolicy,
} from "@rakkr/shared";
import { Gauge, Save } from "lucide-react";
import { toast } from "sonner";

import { Field } from "@/components/settings-fields";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { watchdogCalibrationActionState } from "@/lib/settings-page-helpers";
import { numericInputCommit, watchdogPolicyUpdate } from "@/lib/settings-updates";

export function WatchdogPolicyCard({
  canManage,
  canReadNodes,
  nodes,
  onSaved,
  policy,
}: {
  canManage: boolean;
  canReadNodes: boolean;
  nodes: RecorderNode[];
  onSaved?: () => void;
  policy: WatchdogPolicy;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const [calibrationNodeId, setCalibrationNodeId] = useState(nodes[0]?.id ?? "");
  const [signalMarginDb, setSignalMarginDb] = useState(8);
  const calibrationAction = watchdogCalibrationActionState({
    canManageSettings: canManage,
    canReadNodes,
    nodeCount: nodes.length,
  });
  const mutation = useMutation({
    mutationFn: () => api.updateWatchdogPolicy(policy.id, watchdogPolicyUpdate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The watchdog policy could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data);
      toast.success("Watchdog policy saved");
      void queryClient.invalidateQueries({ queryKey: ["watchdog-policies"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      onSaved?.();
    },
  });
  const calibrationMutation = useMutation({
    mutationFn: () =>
      api.calibrateWatchdogPolicy(policy.id, {
        apply: true,
        nodeId: calibrationNodeId,
        signalMarginDb,
      }),
    onError: () =>
      toast.error("Calibrate failed", {
        description: "The watchdog policy could not be calibrated.",
      }),
    onSuccess: ({ data }) => {
      if (data.policy) {
        setDraft(data.policy);
      }

      void queryClient.invalidateQueries({ queryKey: ["watchdog-policies"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

  useEffect(() => {
    if (!calibrationNodeId && nodes[0]) {
      setCalibrationNodeId(nodes[0].id);
    }
  }, [calibrationNodeId, nodes]);

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Active During">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                activeDuring: value as WatchdogPolicy["activeDuring"],
              }))
            }
            value={draft.activeDuring}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always</SelectItem>
              <SelectItem value="recording">Recording</SelectItem>
              <SelectItem value="scheduled_recording">Scheduled Recording</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Metric">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                metric: value as WatchdogPolicy["metric"],
              }))
            }
            value={draft.metric}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rms">RMS</SelectItem>
              <SelectItem value="peak">Peak</SelectItem>
              <SelectItem value="percentile_95">Percentile 95</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Correlation Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                channelCorrelationMode: value as WatchdogPolicy["channelCorrelationMode"],
              }))
            }
            value={draft.channelCorrelationMode ?? "off"}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="alert_on_high">Alert On High</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Clipping Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                clippingMode: value as WatchdogPolicy["clippingMode"],
              }))
            }
            value={draft.clippingMode ?? "off"}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="alert_on_clipping">Alert On Clipping</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Flatline Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                flatlineMode: value as WatchdogPolicy["flatlineMode"],
              }))
            }
            value={draft.flatlineMode ?? "off"}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="alert_on_flatline">Alert On Flatline</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Quality Alert Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                qualityAlertMode: value as WatchdogPolicy["qualityAlertMode"],
              }))
            }
            value={draft.qualityAlertMode ?? "off"}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="alert_on_noise_hum_static">Alert On Noise Hum Static</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          disabled={!canManage}
          label="Threshold dBFS"
          max={24}
          min={-160}
          onChange={(thresholdDbfs) => setDraft((current) => ({ ...current, thresholdDbfs }))}
          value={draft.thresholdDbfs}
        />
        <NumberField
          disabled={!canManage}
          label="Window Seconds"
          min={1}
          onChange={(windowSeconds) => setDraft((current) => ({ ...current, windowSeconds }))}
          value={draft.windowSeconds}
        />
        <NumberField
          disabled={!canManage}
          label="Grace Seconds"
          min={0}
          onChange={(graceSeconds) => setDraft((current) => ({ ...current, graceSeconds }))}
          value={draft.graceSeconds}
        />
        <NumberField
          disabled={!canManage}
          label="Repeat Seconds"
          min={1}
          onChange={(repeatEverySeconds) =>
            setDraft((current) => ({ ...current, repeatEverySeconds }))
          }
          value={draft.repeatEverySeconds}
        />
        <NumberField
          disabled={!canManage}
          label="Min Above Seconds"
          min={0}
          onChange={(minCumulativeSecondsAboveThreshold) =>
            setDraft((current) => ({ ...current, minCumulativeSecondsAboveThreshold }))
          }
          value={draft.minCumulativeSecondsAboveThreshold}
        />
        <NumberField
          disabled={!canManage}
          label="Correlation Threshold"
          max={1}
          min={0}
          onChange={(channelCorrelationThreshold) =>
            setDraft((current) => ({ ...current, channelCorrelationThreshold }))
          }
          step={0.01}
          value={draft.channelCorrelationThreshold ?? 0.98}
        />
        <NumberField
          disabled={!canManage}
          label="Min Correlated Seconds"
          min={0}
          onChange={(minCumulativeChannelCorrelationSeconds) =>
            setDraft((current) => ({ ...current, minCumulativeChannelCorrelationSeconds }))
          }
          value={
            draft.minCumulativeChannelCorrelationSeconds ?? draft.minCumulativeSecondsAboveThreshold
          }
        />
        <NumberField
          disabled={!canManage}
          label="Min Clipping Seconds"
          min={0}
          onChange={(minCumulativeClippingSeconds) =>
            setDraft((current) => ({ ...current, minCumulativeClippingSeconds }))
          }
          value={draft.minCumulativeClippingSeconds ?? 1}
        />
        <NumberField
          disabled={!canManage}
          label="Flatline dBFS"
          max={24}
          min={-160}
          onChange={(flatlineThresholdDbfs) =>
            setDraft((current) => ({ ...current, flatlineThresholdDbfs }))
          }
          value={draft.flatlineThresholdDbfs ?? -100}
        />
        <NumberField
          disabled={!canManage}
          label="Min Flatline Seconds"
          min={0}
          onChange={(minCumulativeFlatlineSeconds) =>
            setDraft((current) => ({ ...current, minCumulativeFlatlineSeconds }))
          }
          value={draft.minCumulativeFlatlineSeconds ?? 10}
        />
        <NumberField
          disabled={!canManage}
          label="Broadband Noise Threshold"
          max={1}
          min={0}
          onChange={(broadbandNoiseScoreThreshold) =>
            setDraft((current) => ({ ...current, broadbandNoiseScoreThreshold }))
          }
          step={0.01}
          value={draft.broadbandNoiseScoreThreshold ?? 0.85}
        />
        <NumberField
          disabled={!canManage}
          label="Noise Score Threshold"
          max={1}
          min={0}
          onChange={(noiseScoreThreshold) =>
            setDraft((current) => ({ ...current, noiseScoreThreshold }))
          }
          step={0.01}
          value={draft.noiseScoreThreshold ?? 0.9}
        />
        <NumberField
          disabled={!canManage}
          label="Hum Score Threshold"
          max={1}
          min={0}
          onChange={(humScoreThreshold) =>
            setDraft((current) => ({ ...current, humScoreThreshold }))
          }
          step={0.01}
          value={draft.humScoreThreshold ?? 0.8}
        />
        <NumberField
          disabled={!canManage}
          label="Static Score Threshold"
          max={1}
          min={0}
          onChange={(staticScoreThreshold) =>
            setDraft((current) => ({ ...current, staticScoreThreshold }))
          }
          step={0.01}
          value={draft.staticScoreThreshold ?? 0.8}
        />
        <NumberField
          disabled={!canManage}
          label="Min Quality Seconds"
          min={0}
          onChange={(minCumulativeQualitySeconds) =>
            setDraft((current) => ({ ...current, minCumulativeQualitySeconds }))
          }
          value={draft.minCumulativeQualitySeconds ?? draft.minCumulativeSecondsAboveThreshold}
        />
        <Field label="Severity">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                severity: value as WatchdogPolicy["severity"],
              }))
            }
            value={draft.severity}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <Field label="Calibration Node">
          <Select
            disabled={calibrationAction.disabled}
            onValueChange={(value) => setCalibrationNodeId(value)}
            value={calibrationNodeId}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {node.alias} / {node.location.room}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          disabled={calibrationAction.disabled}
          label="Margin dB"
          min={0}
          onChange={setSignalMarginDb}
          value={signalMarginDb}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={
                    calibrationAction.disabled ||
                    calibrationMutation.isPending ||
                    !calibrationNodeId
                  }
                  onClick={() => calibrationMutation.mutate()}
                  type="button"
                  variant="outline"
                >
                  <Gauge className="size-4" />
                  Calibrate
                </Button>
              </span>
            }
          />
          {calibrationAction.title ? (
            <TooltipContent>{calibrationAction.title}</TooltipContent>
          ) : null}
        </Tooltip>
      </div>

      {mutation.isError || calibrationMutation.isError ? (
        <p className="text-sm text-destructive">Save failed.</p>
      ) : null}

      <DialogFooter>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save watchdog policy" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </DialogFooter>
    </div>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  disabled: boolean;
  label: string;
  max?: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  // Local text buffer so the field stays clearable/editable, while an empty or
  // invalid entry never commits a 0 to the draft (audit H4-2): a cleared watchdog
  // threshold (e.g. thresholdDbfs / a score threshold) would otherwise persist 0
  // — a value the server accepts — and arm an always-fire alert. Re-sync from
  // `value` only on a genuine external change (not while typing "0.").
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((current) => (numericInputCommit(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Field label={label}>
      <Input
        disabled={disabled}
        max={max}
        min={min}
        onBlur={() =>
          setText((current) =>
            numericInputCommit(current) === undefined ? String(value) : current,
          )
        }
        onChange={(event) => {
          setText(event.target.value);
          const next = numericInputCommit(event.target.value);

          if (next !== undefined) {
            onChange(next);
          }
        }}
        step={step}
        type="number"
        value={text}
      />
    </Field>
  );
}

// Starting point for a newly created policy: the built-in scheduled-voice
// watchdog with a placeholder name. The server assigns the id; the operator then
// tunes thresholds in this editor.
export function defaultWatchdogPolicyInput(): Omit<WatchdogPolicy, "id"> {
  const { id: _unusedId, ...rest } = defaultScheduledVoiceWatchdogPolicy;

  return { ...rest, name: "New Watchdog Policy" };
}
