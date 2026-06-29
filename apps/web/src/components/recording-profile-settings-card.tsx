import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  defaultRecordingEnhancement,
  type RecordingEnhancement,
  type RecordingProfile,
} from "@rakkr/shared";
import { Save, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { optionalPositiveNumber, recordingProfileUpdate } from "@/lib/settings-updates";

export function RecordingProfileSettingsCard({
  canManage,
  onSaved,
  profile,
}: {
  canManage: boolean;
  onSaved?: () => void;
  profile: RecordingProfile;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(profile);
  const mutation = useMutation({
    mutationFn: () => api.updateRecordingProfile(profile.id, recordingProfileUpdate(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The recording profile could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data);
      toast.success("Recording profile saved");
      void queryClient.invalidateQueries({ queryKey: ["recording-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      onSaved?.();
    },
  });

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const enhancement = draft.enhancement ?? defaultRecordingEnhancement;
  const updateEnhancement = (patch: Partial<RecordingEnhancement>) =>
    setDraft((current) => ({
      ...current,
      enhancement: { ...(current.enhancement ?? defaultRecordingEnhancement), ...patch },
    }));

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </Field>
        <Field label="Codec">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                codec: value as RecordingProfile["codec"],
              }))
            }
            value={draft.codec}
          >
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mp3">MP3</SelectItem>
              <SelectItem value="flac">FLAC</SelectItem>
              <SelectItem value="wav">WAV</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Bitrate">
          <Input
            disabled={!canManage}
            min={1}
            onChange={(event) =>
              setDraft((current) => ({ ...current, bitrateKbps: Number(event.target.value) }))
            }
            type="number"
            value={draft.bitrateKbps}
          />
        </Field>
        <Field label="Max Track Seconds">
          <Input
            disabled={!canManage}
            min={1}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                maxTrackSeconds: optionalPositiveNumber(event.target.value),
              }))
            }
            placeholder="Disabled"
            type="number"
            value={draft.maxTrackSeconds ?? ""}
          />
        </Field>
        <Field label="Channel Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                channelMode: value as RecordingProfile["channelMode"],
              }))
            }
            value={draft.channelMode}
          >
            <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mono">Mono</SelectItem>
              <SelectItem value="stereo">Stereo</SelectItem>
              <SelectItem value="mono_to_stereo_mix">Mono To Stereo Mix</SelectItem>
              <SelectItem value="multichannel">Multichannel</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Toggle
          checked={draft.vbr}
          disabled={!canManage}
          label="VBR"
          onChange={(checked) => setDraft((current) => ({ ...current, vbr: checked }))}
        />
        <Toggle
          checked={draft.silenceDetectionEnabled}
          disabled={!canManage}
          label="Silence Detection"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceDetectionEnabled: checked }))
          }
        />
        <Toggle
          checked={draft.silenceSkipEnabled}
          disabled={!canManage}
          label="Silence Skip"
          onChange={(checked) =>
            setDraft((current) => ({ ...current, silenceSkipEnabled: checked }))
          }
        />
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="mb-3 flex items-center gap-2">
          <Wand2 className="size-4" />
          <h4 className="text-sm font-semibold">Audio enhancement</h4>
          <span className="text-xs text-muted-foreground">
            Applied to the enhanced rendition; the raw master is kept separately
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Toggle
            checked={enhancement.denoise.enabled}
            disabled={!canManage}
            label="Denoise"
            onChange={(checked) =>
              updateEnhancement({ denoise: { ...enhancement.denoise, enabled: checked } })
            }
          />
          <Field label="Denoise Engine">
            <Select
              disabled={!canManage || !enhancement.denoise.enabled}
              onValueChange={(value) =>
                updateEnhancement({
                  denoise: {
                    ...enhancement.denoise,
                    engine: value as RecordingEnhancement["denoise"]["engine"],
                  },
                })
              }
              value={enhancement.denoise.engine}
            >
              <SelectTrigger className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deepfilternet3">DeepFilterNet3</SelectItem>
                <SelectItem value="rnnoise">RNNoise</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Toggle
            checked={enhancement.keepRaw}
            disabled={!canManage}
            label="Keep Raw Master"
            onChange={(checked) => updateEnhancement({ keepRaw: checked })}
          />
          <Toggle
            checked={enhancement.highpass.enabled}
            disabled={!canManage}
            label="High-pass"
            onChange={(checked) =>
              updateEnhancement({ highpass: { ...enhancement.highpass, enabled: checked } })
            }
          />
          <Field label="High-pass Hz">
            <Input
              disabled={!canManage || !enhancement.highpass.enabled}
              min={20}
              onChange={(event) =>
                updateEnhancement({
                  highpass: { ...enhancement.highpass, hz: Number(event.target.value) },
                })
              }
              type="number"
              value={enhancement.highpass.hz}
            />
          </Field>
          <Toggle
            checked={enhancement.lowpass.enabled}
            disabled={!canManage}
            label="Low-pass"
            onChange={(checked) =>
              updateEnhancement({ lowpass: { ...enhancement.lowpass, enabled: checked } })
            }
          />
          <Field label="Low-pass Hz">
            <Input
              disabled={!canManage || !enhancement.lowpass.enabled}
              min={2000}
              onChange={(event) =>
                updateEnhancement({
                  lowpass: { ...enhancement.lowpass, hz: Number(event.target.value) },
                })
              }
              type="number"
              value={enhancement.lowpass.hz}
            />
          </Field>
          <Toggle
            checked={enhancement.loudnorm.enabled}
            disabled={!canManage}
            label="Loudness Norm"
            onChange={(checked) =>
              updateEnhancement({ loudnorm: { ...enhancement.loudnorm, enabled: checked } })
            }
          />
          <Field label="Loudness Target (LUFS)">
            <Input
              disabled={!canManage || !enhancement.loudnorm.enabled}
              max={-5}
              onChange={(event) =>
                updateEnhancement({
                  loudnorm: { ...enhancement.loudnorm, targetI: Number(event.target.value) },
                })
              }
              type="number"
              value={enhancement.loudnorm.targetI}
            />
          </Field>
          <Toggle
            checked={enhancement.deesser.enabled}
            disabled={!canManage}
            label="De-esser"
            onChange={(checked) =>
              updateEnhancement({ deesser: { ...enhancement.deesser, enabled: checked } })
            }
          />
          <Toggle
            checked={enhancement.compressor.enabled}
            disabled={!canManage}
            label="Compressor"
            onChange={(checked) =>
              updateEnhancement({ compressor: { ...enhancement.compressor, enabled: checked } })
            }
          />
          <Toggle
            checked={enhancement.gate.enabled}
            disabled={!canManage}
            label="Noise Gate"
            onChange={(checked) =>
              updateEnhancement({ gate: { ...enhancement.gate, enabled: checked } })
            }
          />
        </div>
      </div>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button disabled={mutation.isPending || !canManage} onClick={() => mutation.mutate()}>
                <Save className="size-4" />
                Save
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {canManage ? "Save recording profile" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
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
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}
