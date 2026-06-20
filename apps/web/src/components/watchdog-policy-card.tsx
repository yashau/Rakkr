import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecorderNode, WatchdogPolicy } from "@rakkr/shared";
import { Gauge, Save, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { watchdogCalibrationActionState } from "@/lib/settings-page-helpers";
import { watchdogPolicyUpdate } from "@/lib/settings-updates";

export function WatchdogPolicyCard({
  canManage,
  canReadNodes,
  nodes,
  policy,
}: {
  canManage: boolean;
  canReadNodes: boolean;
  nodes: RecorderNode[];
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
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["watchdog-policies"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const calibrationMutation = useMutation({
    mutationFn: () =>
      api.calibrateWatchdogPolicy(policy.id, {
        apply: true,
        nodeId: calibrationNodeId,
        signalMarginDb,
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
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="size-4" />
            <h3 className="text-base font-semibold">{policy.name}</h3>
            <Badge className="border-amber-200 bg-amber-50 text-amber-700" variant="outline">
              {policy.id}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {policy.metric} below {policy.thresholdDbfs} dBFS / {policy.windowSeconds}s
          </p>
        </div>
        <Button
          disabled={mutation.isPending || !canManage}
          onClick={() => mutation.mutate()}
          title={canManage ? "Save watchdog policy" : "Requires settings manage"}
        >
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Active During">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                activeDuring: event.target.value as WatchdogPolicy["activeDuring"],
              }))
            }
            value={draft.activeDuring}
          >
            <option value="always">Always</option>
            <option value="recording">Recording</option>
            <option value="scheduled_recording">Scheduled Recording</option>
          </select>
        </Field>
        <Field label="Metric">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                metric: event.target.value as WatchdogPolicy["metric"],
              }))
            }
            value={draft.metric}
          >
            <option value="rms">RMS</option>
            <option value="peak">Peak</option>
            <option value="percentile_95">Percentile 95</option>
          </select>
        </Field>
        <Field label="Correlation Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                channelCorrelationMode: event.target
                  .value as WatchdogPolicy["channelCorrelationMode"],
              }))
            }
            value={draft.channelCorrelationMode ?? "off"}
          >
            <option value="off">Off</option>
            <option value="alert_on_high">Alert On High</option>
          </select>
        </Field>
        <Field label="Clipping Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                clippingMode: event.target.value as WatchdogPolicy["clippingMode"],
              }))
            }
            value={draft.clippingMode ?? "off"}
          >
            <option value="off">Off</option>
            <option value="alert_on_clipping">Alert On Clipping</option>
          </select>
        </Field>
        <Field label="Flatline Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                flatlineMode: event.target.value as WatchdogPolicy["flatlineMode"],
              }))
            }
            value={draft.flatlineMode ?? "off"}
          >
            <option value="off">Off</option>
            <option value="alert_on_flatline">Alert On Flatline</option>
          </select>
        </Field>
        <Field label="Quality Alert Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                qualityAlertMode: event.target.value as WatchdogPolicy["qualityAlertMode"],
              }))
            }
            value={draft.qualityAlertMode ?? "off"}
          >
            <option value="off">Off</option>
            <option value="alert_on_noise_hum_static">Alert On Noise Hum Static</option>
          </select>
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
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                severity: event.target.value as WatchdogPolicy["severity"],
              }))
            }
            value={draft.severity}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
      </div>

      <div className="mt-4 grid gap-3 rounded-md border border-border bg-muted/20 p-3 md:grid-cols-[1fr_140px_auto] md:items-end">
        <Field label="Calibration Node">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            disabled={calibrationAction.disabled}
            onChange={(event) => setCalibrationNodeId(event.target.value)}
            value={calibrationNodeId}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.alias} / {node.location.room}
              </option>
            ))}
          </select>
        </Field>
        <NumberField
          disabled={calibrationAction.disabled}
          label="Margin dB"
          min={0}
          onChange={setSignalMarginDb}
          value={signalMarginDb}
        />
        <Button
          disabled={
            calibrationAction.disabled || calibrationMutation.isPending || !calibrationNodeId
          }
          onClick={() => calibrationMutation.mutate()}
          title={calibrationAction.title}
          type="button"
          variant="outline"
        >
          <Gauge className="size-4" />
          Calibrate
        </Button>
      </div>

      {mutation.isError || calibrationMutation.isError ? (
        <p className="mt-3 text-sm text-destructive">Save failed.</p>
      ) : null}
    </Card>
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
  return (
    <Field label={label}>
      <Input
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </Field>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
