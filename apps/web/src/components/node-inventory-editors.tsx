import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  defaultNodeRecordingCapacity,
  type AudioInterface,
  type NodeAudioCommandDefaults,
  type RecorderNode,
} from "@rakkr/shared";
import { AudioLines, Save, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";

interface NodeIdentityDraft {
  alias: string;
  building: string;
  floor: string;
  hostname: string;
  ipAddresses: string;
  maxConcurrentRecordings: string;
  notes: string;
  room: string;
  site: string;
  tags: string;
}

interface NodeInterfaceDraft {
  alias: string;
  channels: Array<{
    alias: string;
    index: number;
  }>;
  hardwarePath: string;
  sampleRates: string;
  serialNumber: string;
  systemName: string;
  systemRef: string;
}

interface NodeAudioDefaultsDraft {
  captureArgsTemplate: string;
  captureBackend: "" | "alsa" | "jack" | "pipewire";
  captureChannels: string;
  captureCommand: string;
  captureDevice: string;
  captureFormat: string;
  captureSampleRate: string;
  meterArgsTemplate: string;
}

export function NodeIdentityEditor({
  canManage,
  node,
}: {
  canManage: boolean;
  node: RecorderNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(nodeIdentityDraft(node));
  const mutation = useMutation({
    mutationFn: () => api.updateNode(node.id, nodeUpdateInput(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The node details could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(nodeIdentityDraft(data));
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  useEffect(() => {
    setDraft(nodeIdentityDraft(node));
  }, [node]);

  return (
    <fieldset
      aria-disabled={!canManage}
      className="grid gap-3 rounded-md border border-border bg-muted/20 p-3"
      disabled={!canManage}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Node Details</div>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                  size="sm"
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save node details" : "Requires node manage"}
          </TooltipContent>
        </Tooltip>
      </div>
      <Field label="Alias">
        <Input
          onChange={(event) => setDraftValue(setDraft, "alias", event.target.value)}
          value={draft.alias}
        />
      </Field>
      <div className="grid gap-2 md:grid-cols-4">
        <Field label="Site">
          <Input
            onChange={(event) => setDraftValue(setDraft, "site", event.target.value)}
            value={draft.site}
          />
        </Field>
        <Field label="Building">
          <Input
            onChange={(event) => setDraftValue(setDraft, "building", event.target.value)}
            value={draft.building}
          />
        </Field>
        <Field label="Floor">
          <Input
            onChange={(event) => setDraftValue(setDraft, "floor", event.target.value)}
            value={draft.floor}
          />
        </Field>
        <Field label="Room">
          <Input
            onChange={(event) => setDraftValue(setDraft, "room", event.target.value)}
            value={draft.room}
          />
        </Field>
      </div>
      <Field label="Hostname">
        <Input
          onChange={(event) => setDraftValue(setDraft, "hostname", event.target.value)}
          value={draft.hostname}
        />
      </Field>
      <Field label="Max Concurrent Recordings">
        <Input
          max={128}
          min={1}
          onChange={(event) =>
            setDraftValue(setDraft, "maxConcurrentRecordings", event.target.value)
          }
          type="number"
          value={draft.maxConcurrentRecordings}
        />
      </Field>
      <Field label="IP Addresses">
        <Input
          onChange={(event) => setDraftValue(setDraft, "ipAddresses", event.target.value)}
          value={draft.ipAddresses}
        />
      </Field>
      <Field label="Tags">
        <Input
          onChange={(event) => setDraftValue(setDraft, "tags", event.target.value)}
          value={draft.tags}
        />
      </Field>
      <Field label="Notes">
        <Textarea
          onChange={(event) => setDraftValue(setDraft, "notes", event.target.value)}
          value={draft.notes}
        />
      </Field>
      {mutation.isError ? <p className="text-sm text-destructive">Node update failed.</p> : null}
    </fieldset>
  );
}

export function NodeAudioDefaultsEditor({
  canManage,
  node,
}: {
  canManage: boolean;
  node: RecorderNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(nodeAudioDefaultsDraft(node.audioDefaults));
  const mutation = useMutation({
    mutationFn: () => api.updateNode(node.id, { audioDefaults: nodeAudioDefaultsInput(draft) }),
    onError: () =>
      toast.error("Save failed", {
        description: "The node audio defaults could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(nodeAudioDefaultsDraft(data.audioDefaults));
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  useEffect(() => {
    setDraft(nodeAudioDefaultsDraft(node.audioDefaults));
  }, [node]);

  return (
    <fieldset
      aria-disabled={!canManage}
      className="grid gap-3 rounded-md border border-border bg-transparent p-3"
      disabled={!canManage}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal className="size-4" />
          Audio Defaults
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                  size="sm"
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save audio defaults" : "Requires node manage"}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Capture Backend">
          <Select
            onValueChange={(value) =>
              setDraftValue(
                setDraft,
                "captureBackend",
                (value === "__all__" ? "" : value) as NodeAudioDefaultsDraft["captureBackend"],
              )
            }
            value={draft.captureBackend || "__all__"}
          >
            <SelectTrigger className="px-3 py-2">
              <SelectValue placeholder="ALSA default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">ALSA default</SelectItem>
              <SelectItem value="alsa">ALSA</SelectItem>
              <SelectItem value="jack">JACK</SelectItem>
              <SelectItem value="pipewire">PipeWire</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Capture Command">
          <Input
            onChange={(event) => setDraftValue(setDraft, "captureCommand", event.target.value)}
            placeholder="arecord"
            value={draft.captureCommand}
          />
        </Field>
        <Field label="Capture Device">
          <Input
            onChange={(event) => setDraftValue(setDraft, "captureDevice", event.target.value)}
            placeholder="default / hw:1,0"
            value={draft.captureDevice}
          />
        </Field>
        <Field label="Format">
          <Input
            onChange={(event) => setDraftValue(setDraft, "captureFormat", event.target.value)}
            placeholder="S16_LE"
            value={draft.captureFormat}
          />
        </Field>
        <Field label="Sample Rate">
          <Input
            min={1}
            onChange={(event) => setDraftValue(setDraft, "captureSampleRate", event.target.value)}
            placeholder="48000"
            type="number"
            value={draft.captureSampleRate}
          />
        </Field>
        <Field label="Channels">
          <Input
            min={1}
            onChange={(event) => setDraftValue(setDraft, "captureChannels", event.target.value)}
            placeholder="2"
            type="number"
            value={draft.captureChannels}
          />
        </Field>
      </div>
      <Field label="Capture Args Template">
        <Textarea
          onChange={(event) => setDraftValue(setDraft, "captureArgsTemplate", event.target.value)}
          placeholder="-D {device} -f {format} -r {sample_rate} -c {channels} -d {seconds} {output}"
          value={draft.captureArgsTemplate}
        />
      </Field>
      <Field label="Meter Args Template">
        <Textarea
          onChange={(event) => setDraftValue(setDraft, "meterArgsTemplate", event.target.value)}
          placeholder="-D {device} -f {format} -r {sample_rate} -c {channels} -d {seconds} -t raw -"
          value={draft.meterArgsTemplate}
        />
      </Field>
      {mutation.isError ? (
        <p className="text-sm text-destructive">Audio defaults update failed.</p>
      ) : null}
    </fieldset>
  );
}

export function NodeInterfaceEditor({
  audioInterface,
  canManage,
  node,
}: {
  audioInterface: AudioInterface;
  canManage: boolean;
  node: RecorderNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(nodeInterfaceDraft(audioInterface));
  const mutation = useMutation({
    mutationFn: () =>
      api.updateNodeInterface(node.id, audioInterface.id, nodeInterfaceUpdateInput(draft)),
    onError: () =>
      toast.error("Save failed", {
        description: "The interface details could not be saved.",
      }),
    onSuccess: ({ data }) => {
      const updated = data.interfaces.find((candidate) => candidate.id === audioInterface.id);

      if (updated) {
        setDraft(nodeInterfaceDraft(updated));
      }

      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  useEffect(() => {
    setDraft(nodeInterfaceDraft(audioInterface));
  }, [audioInterface]);

  return (
    <fieldset
      aria-disabled={!canManage}
      className="grid gap-3 rounded-md border border-border bg-transparent p-3"
      disabled={!canManage}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AudioLines className="size-4" />
          Interface Details
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Button
                  disabled={mutation.isPending || !canManage}
                  onClick={() => mutation.mutate()}
                  size="sm"
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {canManage ? "Save interface details" : "Requires node manage"}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{audioInterface.backend}</Badge>
        <Badge variant="outline">{audioInterface.channelCount} channels</Badge>
      </div>
      <Field label="Alias">
        <Input
          onChange={(event) => setDraftValue(setDraft, "alias", event.target.value)}
          value={draft.alias}
        />
      </Field>
      <Field label="System Name">
        <Input
          onChange={(event) => setDraftValue(setDraft, "systemName", event.target.value)}
          value={draft.systemName}
        />
      </Field>
      <Field label="System Ref">
        <Input
          onChange={(event) => setDraftValue(setDraft, "systemRef", event.target.value)}
          placeholder="hw:1,0 / usb path / device ref"
          value={draft.systemRef}
        />
      </Field>
      <Field label="Hardware Path">
        <Input
          onChange={(event) => setDraftValue(setDraft, "hardwarePath", event.target.value)}
          placeholder="/proc/asound/card1/pcm0c or USB path"
          value={draft.hardwarePath}
        />
      </Field>
      <Field label="Serial Number">
        <Input
          onChange={(event) => setDraftValue(setDraft, "serialNumber", event.target.value)}
          value={draft.serialNumber}
        />
      </Field>
      <Field label="Sample Rates">
        <Input
          onChange={(event) => setDraftValue(setDraft, "sampleRates", event.target.value)}
          value={draft.sampleRates}
        />
      </Field>
      {draft.channels.length > 0 ? (
        <div className="grid gap-2">
          <Label>Channel Aliases</Label>
          <div className="grid max-h-64 gap-2 overflow-auto pr-1">
            {draft.channels.map((channel) => (
              <div className="grid grid-cols-[3rem_1fr] items-center gap-2" key={channel.index}>
                <Badge className="justify-center tabular-nums" variant="outline">
                  {channel.index}
                </Badge>
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      channels: current.channels.map((candidate) =>
                        candidate.index === channel.index
                          ? { ...candidate, alias: event.target.value }
                          : candidate,
                      ),
                    }))
                  }
                  value={channel.alias}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No channel aliases reported.</p>
      )}
      {mutation.isError ? (
        <p className="text-sm text-destructive">Interface update failed.</p>
      ) : null}
    </fieldset>
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

function nodeIdentityDraft(node: RecorderNode): NodeIdentityDraft {
  return {
    alias: node.alias,
    building: node.location.building ?? "",
    floor: node.location.floor ?? "",
    hostname: node.hostname,
    ipAddresses: node.ipAddresses.join(", "),
    maxConcurrentRecordings: String(
      node.recordingCapacity?.maxConcurrentRecordings ??
        defaultNodeRecordingCapacity.maxConcurrentRecordings,
    ),
    notes: node.notes ?? "",
    room: node.location.room,
    site: node.location.site,
    tags: node.tags.join(", "),
  };
}

function nodeUpdateInput(draft: NodeIdentityDraft) {
  return {
    alias: draft.alias.trim(),
    hostname: draft.hostname.trim(),
    ipAddresses: parseList(draft.ipAddresses),
    location: {
      building: optionalText(draft.building),
      floor: optionalText(draft.floor),
      room: draft.room.trim(),
      site: draft.site.trim(),
    },
    notes: draft.notes.trim() || null,
    recordingCapacity: {
      maxConcurrentRecordings: positiveInteger(
        draft.maxConcurrentRecordings,
        defaultNodeRecordingCapacity.maxConcurrentRecordings,
      ),
    },
    tags: parseList(draft.tags),
  };
}

function nodeAudioDefaultsDraft(
  defaults: NodeAudioCommandDefaults | undefined,
): NodeAudioDefaultsDraft {
  return {
    captureArgsTemplate: defaults?.captureArgsTemplate ?? "",
    captureBackend: defaults?.captureBackend ?? "",
    captureChannels:
      defaults?.captureChannels === undefined ? "" : String(defaults.captureChannels),
    captureCommand: defaults?.captureCommand ?? "",
    captureDevice: defaults?.captureDevice ?? "",
    captureFormat: defaults?.captureFormat ?? "",
    captureSampleRate:
      defaults?.captureSampleRate === undefined ? "" : String(defaults.captureSampleRate),
    meterArgsTemplate: defaults?.meterArgsTemplate ?? "",
  };
}

function nodeAudioDefaultsInput(draft: NodeAudioDefaultsDraft): NodeAudioCommandDefaults {
  return {
    captureArgsTemplate: optionalTextValue(draft.captureArgsTemplate),
    captureBackend: draft.captureBackend || undefined,
    captureChannels: optionalPositiveInteger(draft.captureChannels),
    captureCommand: optionalTextValue(draft.captureCommand),
    captureDevice: optionalTextValue(draft.captureDevice),
    captureFormat: optionalTextValue(draft.captureFormat),
    captureSampleRate: optionalPositiveInteger(draft.captureSampleRate),
    meterArgsTemplate: optionalTextValue(draft.meterArgsTemplate),
  };
}

function positiveInteger(value: string, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalText(value: string) {
  return value.trim() || null;
}

function optionalTextValue(value: string) {
  return value.trim() || undefined;
}

function optionalPositiveInteger(value: string) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nodeInterfaceDraft(audioInterface: AudioInterface): NodeInterfaceDraft {
  return {
    alias: audioInterface.alias,
    channels: audioInterface.channels.map((channel) => ({ ...channel })),
    hardwarePath: audioInterface.hardwarePath ?? "",
    sampleRates: audioInterface.sampleRates.join(", "),
    serialNumber: audioInterface.serialNumber ?? "",
    systemName: audioInterface.systemName,
    systemRef: audioInterface.systemRef ?? "",
  };
}

function nodeInterfaceUpdateInput(draft: NodeInterfaceDraft) {
  const hardwarePath = draft.hardwarePath.trim();
  const serialNumber = draft.serialNumber.trim();
  const systemRef = draft.systemRef.trim();

  return {
    alias: draft.alias.trim(),
    channels: draft.channels.map((channel) => ({
      alias: channel.alias.trim() || `Channel ${channel.index}`,
      index: channel.index,
    })),
    hardwarePath: hardwarePath || null,
    sampleRates: parseNumbers(draft.sampleRates),
    serialNumber: serialNumber || null,
    systemName: draft.systemName.trim(),
    systemRef: systemRef || undefined,
  };
}

function setDraftValue<Draft>(
  setDraft: Dispatch<SetStateAction<Draft>>,
  key: keyof Draft,
  value: Draft[keyof Draft],
) {
  setDraft((current) => ({ ...current, [key]: value }));
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumbers(value: string) {
  return parseList(value)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
}
