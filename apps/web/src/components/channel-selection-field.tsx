import type { AudioInterface, ChannelMode } from "@rakkr/shared";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const channelModes: { label: string; value: ChannelMode }[] = [
  { label: "Stereo pair", value: "stereo" },
  { label: "Mono", value: "mono" },
  { label: "Mono mix → stereo", value: "mono_to_stereo_mix" },
  { label: "Multichannel", value: "multichannel" },
];

const modeSelectClassName = "w-full min-w-0 sm:w-44";

export interface ChannelSelectionValue {
  channels: number[];
  mode: "" | ChannelMode;
}

interface ChannelSelectionFieldProps {
  audioInterface?: AudioInterface;
  // Channels currently held by other overlapping captures on this interface.
  busyChannels?: number[];
  idPrefix: string;
  onChange: (value: ChannelSelectionValue) => void;
  value: ChannelSelectionValue;
}

// Per-channel selection for a single interface: pick the source channels this
// recording/schedule owns and how they map to the output. An empty selection
// records the whole interface.
export function ChannelSelectionField({
  audioInterface,
  busyChannels = [],
  idPrefix,
  onChange,
  value,
}: ChannelSelectionFieldProps) {
  if (!audioInterface) {
    return null;
  }

  const channels =
    audioInterface.channels.length > 0
      ? audioInterface.channels
      : Array.from({ length: audioInterface.channelCount }, (_, index) => ({
          alias: `Channel ${index + 1}`,
          index: index + 1,
        }));
  const busy = new Set(busyChannels);
  const selectedCount = value.channels.length;
  const effectiveMode: ChannelMode = value.mode || (selectedCount === 1 ? "mono" : "stereo");

  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={`${idPrefix}-channels`}>Channels</Label>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          className="flex-wrap justify-start gap-1"
          id={`${idPrefix}-channels`}
          onValueChange={(values) =>
            onChange({
              channels: [...new Set(values.map(Number))].sort((left, right) => left - right),
              mode: value.mode,
            })
          }
          multiple
          value={value.channels.map(String)}
          variant="outline"
        >
          {channels.map((channel) => (
            <ToggleGroupItem
              className={cn(
                "h-9 min-w-9 px-2 text-xs",
                busy.has(channel.index) &&
                  !value.channels.includes(channel.index) &&
                  "border-destructive/60 text-destructive",
              )}
              key={channel.index}
              title={
                busy.has(channel.index)
                  ? `${channel.alias} — in use by another capture`
                  : channel.alias
              }
              value={String(channel.index)}
            >
              {channel.index}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select
          disabled={selectedCount === 0}
          onValueChange={(mode) =>
            onChange({ channels: value.channels, mode: mode as ChannelMode })
          }
          value={selectedCount === 0 ? "" : effectiveMode}
        >
          <SelectTrigger className={modeSelectClassName}>
            <SelectValue placeholder="Output mode" />
          </SelectTrigger>
          <SelectContent>
            {channelModes.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedCount === 0
          ? "No channels selected — records the whole interface."
          : channelSelectionHint(value.channels, effectiveMode)}
      </p>
    </div>
  );
}

export function channelSelectionHint(channels: number[], mode: ChannelMode): string {
  const list = channels.join(", ");

  if (mode === "stereo") {
    return channels.length === 2
      ? `Stereo: ch ${channels[0]} → L, ch ${channels[1]} → R.`
      : `Stereo needs exactly 2 channels (selected ${channels.length}).`;
  }

  if (mode === "multichannel") {
    return `Multichannel: ${channels.length} channel${channels.length === 1 ? "" : "s"} (${list}).`;
  }

  return `Mono mix of ch ${list}.`;
}
