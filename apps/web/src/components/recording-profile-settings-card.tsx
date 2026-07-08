import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  defaultRecordingEnhancement,
  defaultVoiceRecordingProfile,
  type RecordingEnhancement,
  type RecordingProfile,
} from "@rakkr/shared";
import { Save, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { Field, NumberField, Toggle } from "@/components/settings-fields";
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
    <div className="grid gap-5">
      <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mp3">MP3</SelectItem>
              <SelectItem value="flac">FLAC</SelectItem>
              <SelectItem value="wav">WAV</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          disabled={!canManage}
          label="Bitrate"
          min={1}
          onChange={(bitrateKbps) => setDraft((current) => ({ ...current, bitrateKbps }))}
          value={draft.bitrateKbps}
        />
        <Field label="Chunk Length (seconds)">
          <Input
            disabled={!canManage}
            min={1}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                chunkSeconds: optionalPositiveNumber(event.target.value),
              }))
            }
            placeholder="Single file"
            type="number"
            value={draft.chunkSeconds ?? draft.maxTrackSeconds ?? ""}
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
            <SelectTrigger className="w-full">
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

      <div className="border-t border-border pt-5">
        <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Wand2 className="size-4" />
          <h4 className="text-sm font-semibold">Audio enhancement</h4>
          <span className="text-xs text-muted-foreground">
            Applied to the enhanced rendition; the raw master is kept separately
          </span>
        </div>
        <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              <SelectTrigger className="w-full">
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
          <NumberField
            disabled={!canManage || !enhancement.highpass.enabled}
            label="High-pass Hz"
            min={20}
            onChange={(hz) => updateEnhancement({ highpass: { ...enhancement.highpass, hz } })}
            value={enhancement.highpass.hz}
          />
          <Toggle
            checked={enhancement.lowpass.enabled}
            disabled={!canManage}
            label="Low-pass"
            onChange={(checked) =>
              updateEnhancement({ lowpass: { ...enhancement.lowpass, enabled: checked } })
            }
          />
          <NumberField
            disabled={!canManage || !enhancement.lowpass.enabled}
            label="Low-pass Hz"
            min={2000}
            onChange={(hz) => updateEnhancement({ lowpass: { ...enhancement.lowpass, hz } })}
            value={enhancement.lowpass.hz}
          />
          <Toggle
            checked={enhancement.loudnorm.enabled}
            disabled={!canManage}
            label="Loudness Norm"
            onChange={(checked) =>
              updateEnhancement({ loudnorm: { ...enhancement.loudnorm, enabled: checked } })
            }
          />
          <NumberField
            disabled={!canManage || !enhancement.loudnorm.enabled}
            label="Loudness Target (LUFS)"
            max={-5}
            onChange={(targetI) =>
              updateEnhancement({ loudnorm: { ...enhancement.loudnorm, targetI } })
            }
            value={enhancement.loudnorm.targetI}
          />
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
            {canManage ? "Save recording profile" : "Requires settings manage"}
          </TooltipContent>
        </Tooltip>
      </DialogFooter>
    </div>
  );
}

// Starting point for a newly created profile: the built-in voice template with
// a placeholder name. The server assigns the id; the operator then refines the
// rest in this editor.
export function defaultRecordingProfileInput(): Omit<RecordingProfile, "id"> {
  const { id: _unusedId, ...rest } = defaultVoiceRecordingProfile;

  return { ...rest, name: "New Recording Profile" };
}
