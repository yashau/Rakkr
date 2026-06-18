import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RecordingProfile,
  RecordingProfileUpdate,
  WatchdogPolicy,
  WatchdogPolicyUpdate,
} from "@rakkr/shared";
import { Save, ShieldAlert, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

export function SettingsPage() {
  const profilesQuery = useQuery({
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const watchdogPoliciesQuery = useQuery({
    queryFn: api.watchdogPolicies,
    queryKey: ["watchdog-policies"],
  });

  return (
    <div className="grid gap-6">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recording Profiles</h2>
          <p className="text-sm text-muted-foreground">Central audio defaults and templates.</p>
        </div>
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {profilesQuery.data?.data.length ?? 0} profiles
        </Badge>
      </section>

      <div className="grid gap-4">
        {(profilesQuery.data?.data ?? []).map((profile) => (
          <RecordingProfileCard key={profile.id} profile={profile} />
        ))}
      </div>

      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Watchdog Policies</h2>
          <p className="text-sm text-muted-foreground">Scheduled signal health thresholds.</p>
        </div>
        <Badge className="w-fit border-slate-200 bg-slate-50 text-slate-700" variant="outline">
          {watchdogPoliciesQuery.data?.data.length ?? 0} policies
        </Badge>
      </section>

      <div className="grid gap-4">
        {(watchdogPoliciesQuery.data?.data ?? []).map((policy) => (
          <WatchdogPolicyCard key={policy.id} policy={policy} />
        ))}
      </div>
    </div>
  );
}

function RecordingProfileCard({ profile }: { profile: RecordingProfile }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(profile);
  const mutation = useMutation({
    mutationFn: () => api.updateRecordingProfile(profile.id, recordingProfileUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["recording-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <SlidersHorizontal className="size-4" />
            <h3 className="text-base font-semibold">{profile.name}</h3>
            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">
              {profile.id}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {profile.codec.toUpperCase()} / {profile.bitrateKbps} kbps / {profile.channelMode}
          </p>
        </div>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Codec">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                codec: event.target.value as RecordingProfile["codec"],
              }))
            }
            value={draft.codec}
          >
            <option value="mp3">MP3</option>
            <option value="flac">FLAC</option>
            <option value="wav">WAV</option>
          </select>
        </Field>
        <Field label="Bitrate">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, bitrateKbps: Number(event.target.value) }))
            }
            type="number"
            value={draft.bitrateKbps}
          />
        </Field>
        <Field label="Channel Mode">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                channelMode: event.target.value as RecordingProfile["channelMode"],
              }))
            }
            value={draft.channelMode}
          >
            <option value="mono">Mono</option>
            <option value="stereo">Stereo</option>
            <option value="mono_to_stereo_mix">Mono To Stereo Mix</option>
            <option value="multichannel">Multichannel</option>
          </select>
        </Field>
        <Toggle
          checked={draft.vbr}
          label="VBR"
          onChange={(checked) => setDraft((current) => ({ ...current, vbr: checked }))}
        />
        <Toggle
          checked={draft.silenceDetectionEnabled}
          label="Silence Detection"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceDetectionEnabled: checked }))
          }
        />
        <Toggle
          checked={draft.silenceSkipEnabled}
          label="Silence Skip"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceSkipEnabled: checked }))
          }
        />
      </div>

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function WatchdogPolicyCard({ policy }: { policy: WatchdogPolicy }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const mutation = useMutation({
    mutationFn: () => api.updateWatchdogPolicy(policy.id, watchdogPolicyUpdate(draft)),
    onSuccess: ({ data }) => {
      setDraft(data);
      void queryClient.invalidateQueries({ queryKey: ["watchdog-policies"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(policy);
  }, [policy]);

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
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Active During">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
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
        <Field label="Threshold dBFS">
          <Input
            max={24}
            min={-160}
            onChange={(event) =>
              setDraft((current) => ({ ...current, thresholdDbfs: Number(event.target.value) }))
            }
            type="number"
            value={draft.thresholdDbfs}
          />
        </Field>
        <Field label="Window Seconds">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, windowSeconds: Number(event.target.value) }))
            }
            type="number"
            value={draft.windowSeconds}
          />
        </Field>
        <Field label="Grace Seconds">
          <Input
            min={0}
            onChange={(event) =>
              setDraft((current) => ({ ...current, graceSeconds: Number(event.target.value) }))
            }
            type="number"
            value={draft.graceSeconds}
          />
        </Field>
        <Field label="Repeat Seconds">
          <Input
            min={1}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                repeatEverySeconds: Number(event.target.value),
              }))
            }
            type="number"
            value={draft.repeatEverySeconds}
          />
        </Field>
        <Field label="Min Above Seconds">
          <Input
            min={0}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                minCumulativeSecondsAboveThreshold: Number(event.target.value),
              }))
            }
            type="number"
            value={draft.minCumulativeSecondsAboveThreshold}
          />
        </Field>
        <Field label="Severity">
          <select
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
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

      {mutation.isError ? <p className="mt-3 text-sm text-destructive">Save failed.</p> : null}
    </Card>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
      <input
        checked={checked}
        className="size-4"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

function recordingProfileUpdate(profile: RecordingProfile): RecordingProfileUpdate {
  return {
    bitrateKbps: profile.bitrateKbps,
    channelMode: profile.channelMode,
    codec: profile.codec,
    name: profile.name,
    silenceDetectionEnabled: profile.silenceDetectionEnabled,
    silenceSkipEnabled: profile.silenceSkipEnabled,
    vbr: profile.vbr,
  };
}

function watchdogPolicyUpdate(policy: WatchdogPolicy): WatchdogPolicyUpdate {
  return {
    activeDuring: policy.activeDuring,
    graceSeconds: policy.graceSeconds,
    metric: policy.metric,
    minCumulativeSecondsAboveThreshold: policy.minCumulativeSecondsAboveThreshold,
    name: policy.name,
    repeatEverySeconds: policy.repeatEverySeconds,
    severity: policy.severity,
    thresholdDbfs: policy.thresholdDbfs,
    windowSeconds: policy.windowSeconds,
  };
}
