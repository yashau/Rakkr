import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AudioInterface, RecorderNode } from "@rakkr/shared";
import { AudioLines, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

interface NodeIdentityDraft {
  alias: string;
  hostname: string;
  ipAddresses: string;
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
  sampleRates: string;
  systemName: string;
  systemRef: string;
}

export function NodeIdentityEditor({ node }: { node: RecorderNode }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(nodeIdentityDraft(node));
  const mutation = useMutation({
    mutationFn: () => api.updateNode(node.id, nodeUpdateInput(draft)),
    onSuccess: ({ data }) => {
      setDraft(nodeIdentityDraft(data));
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  useEffect(() => {
    setDraft(nodeIdentityDraft(node));
  }, [node]);

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Node Details</div>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()} size="sm">
          <Save className="size-4" />
          Save
        </Button>
      </div>
      <Field label="Alias">
        <Input
          onChange={(event) => setDraftValue(setDraft, "alias", event.target.value)}
          value={draft.alias}
        />
      </Field>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Site">
          <Input
            onChange={(event) => setDraftValue(setDraft, "site", event.target.value)}
            value={draft.site}
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
    </div>
  );
}

export function NodeInterfaceEditor({
  audioInterface,
  node,
}: {
  audioInterface: AudioInterface;
  node: RecorderNode;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(nodeInterfaceDraft(audioInterface));
  const mutation = useMutation({
    mutationFn: () =>
      api.updateNodeInterface(node.id, audioInterface.id, nodeInterfaceUpdateInput(draft)),
    onSuccess: ({ data }) => {
      const updated = data.interfaces.find((candidate) => candidate.id === audioInterface.id);

      if (updated) {
        setDraft(nodeInterfaceDraft(updated));
      }

      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });

  useEffect(() => {
    setDraft(nodeInterfaceDraft(audioInterface));
  }, [audioInterface]);

  return (
    <div className="grid gap-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AudioLines className="size-4" />
          Interface Details
        </div>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()} size="sm">
          <Save className="size-4" />
          Save
        </Button>
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

function nodeIdentityDraft(node: RecorderNode): NodeIdentityDraft {
  return {
    alias: node.alias,
    hostname: node.hostname,
    ipAddresses: node.ipAddresses.join(", "),
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
      room: draft.room.trim(),
      site: draft.site.trim(),
    },
    notes: draft.notes.trim() || null,
    tags: parseList(draft.tags),
  };
}

function nodeInterfaceDraft(audioInterface: AudioInterface): NodeInterfaceDraft {
  return {
    alias: audioInterface.alias,
    channels: audioInterface.channels.map((channel) => ({ ...channel })),
    sampleRates: audioInterface.sampleRates.join(", "),
    systemName: audioInterface.systemName,
    systemRef: audioInterface.systemRef ?? "",
  };
}

function nodeInterfaceUpdateInput(draft: NodeInterfaceDraft) {
  const systemRef = draft.systemRef.trim();

  return {
    alias: draft.alias.trim(),
    channels: draft.channels.map((channel) => ({
      alias: channel.alias.trim() || `Channel ${channel.index}`,
      index: channel.index,
    })),
    sampleRates: parseNumbers(draft.sampleRates),
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
