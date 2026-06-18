import { type Dispatch, type ReactNode, type SetStateAction, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Headphones, KeyRound, MapPin, Network, PlusCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type NodeEnrollmentInput, type NodeEnrollmentResult } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

interface EnrollmentDraft {
  agentVersion: string;
  alias: string;
  backend: NodeEnrollmentInput["interfaces"][number]["backend"];
  channelCount: string;
  hostname: string;
  interfaceAlias: string;
  ipAddresses: string;
  notes: string;
  room: string;
  sampleRates: string;
  site: string;
  systemName: string;
  tags: string;
}

const emptyDraft: EnrollmentDraft = {
  agentVersion: "0.1.0",
  alias: "",
  backend: "unknown",
  channelCount: "0",
  hostname: "",
  interfaceAlias: "",
  ipAddresses: "",
  notes: "",
  room: "",
  sampleRates: "",
  site: "",
  systemName: "",
  tags: "",
};

export function NodesPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(emptyDraft);
  const [credential, setCredential] = useState<NodeEnrollmentResult | undefined>();
  const nodesQuery = useQuery({
    queryFn: api.nodes,
    queryKey: ["nodes"],
    refetchInterval: 5000,
  });
  const listenMutation = useMutation({
    mutationFn: api.startListen,
  });
  const enrollMutation = useMutation({
    mutationFn: api.enrollNode,
    onSuccess: ({ data }) => {
      setCredential(data);
      setDraft(emptyDraft);
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });
  const rotateMutation = useMutation({
    mutationFn: api.rotateNodeCredential,
    onSuccess: ({ data }) => {
      setCredential(data);
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    },
  });

  return (
    <div className="grid gap-4">
      <Card className="rounded-lg p-4 shadow-sm">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            enrollMutation.mutate(enrollmentInput(draft));
          }}
        >
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Enroll Recorder Node</h2>
              <p className="text-sm text-muted-foreground">Create a persisted node and token.</p>
            </div>
            <Button disabled={enrollMutation.isPending} type="submit">
              <PlusCircle className="size-4" />
              Enroll
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Alias">
              <Input
                onChange={(event) => setDraftValue(setDraft, "alias", event.target.value)}
                required
                value={draft.alias}
              />
            </Field>
            <Field label="Hostname">
              <Input
                onChange={(event) => setDraftValue(setDraft, "hostname", event.target.value)}
                required
                value={draft.hostname}
              />
            </Field>
            <Field label="Agent Version">
              <Input
                onChange={(event) => setDraftValue(setDraft, "agentVersion", event.target.value)}
                required
                value={draft.agentVersion}
              />
            </Field>
            <Field label="Site">
              <Input
                onChange={(event) => setDraftValue(setDraft, "site", event.target.value)}
                required
                value={draft.site}
              />
            </Field>
            <Field label="Room">
              <Input
                onChange={(event) => setDraftValue(setDraft, "room", event.target.value)}
                required
                value={draft.room}
              />
            </Field>
            <Field label="IP Addresses">
              <Input
                onChange={(event) => setDraftValue(setDraft, "ipAddresses", event.target.value)}
                placeholder="10.0.0.25, 10.0.0.26"
                value={draft.ipAddresses}
              />
            </Field>
            <Field label="Interface">
              <Input
                onChange={(event) => setDraftValue(setDraft, "interfaceAlias", event.target.value)}
                placeholder="USB Audio"
                value={draft.interfaceAlias}
              />
            </Field>
            <Field label="Backend">
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) =>
                  setDraftValue(
                    setDraft,
                    "backend",
                    event.target.value as EnrollmentDraft["backend"],
                  )
                }
                value={draft.backend}
              >
                <option value="unknown">unknown</option>
                <option value="alsa">alsa</option>
                <option value="jack">jack</option>
                <option value="pipewire">pipewire</option>
              </select>
            </Field>
            <Field label="Channels">
              <Input
                min={0}
                onChange={(event) => setDraftValue(setDraft, "channelCount", event.target.value)}
                type="number"
                value={draft.channelCount}
              />
            </Field>
            <Field label="System Name">
              <Input
                onChange={(event) => setDraftValue(setDraft, "systemName", event.target.value)}
                placeholder="Behringer X32 Rack USB"
                value={draft.systemName}
              />
            </Field>
            <Field label="Sample Rates">
              <Input
                onChange={(event) => setDraftValue(setDraft, "sampleRates", event.target.value)}
                placeholder="48000, 44100"
                value={draft.sampleRates}
              />
            </Field>
            <Field label="Tags">
              <Input
                onChange={(event) => setDraftValue(setDraft, "tags", event.target.value)}
                placeholder="voice, room-a"
                value={draft.tags}
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              onChange={(event) => setDraftValue(setDraft, "notes", event.target.value)}
              value={draft.notes}
            />
          </Field>

          {credential ? (
            <Field label="One-Time Node Token">
              <Textarea readOnly value={credential.credential.token} />
            </Field>
          ) : null}
          {enrollMutation.isError ? (
            <p className="text-sm text-destructive">Node enrollment failed.</p>
          ) : null}
        </form>
      </Card>

      {nodesQuery.data?.data.map((node) => (
        <Card className="rounded-lg p-4 shadow-sm" key={node.id}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-lg font-semibold">{node.alias}</h2>
                <Badge
                  className="border-emerald-200 bg-emerald-50 text-emerald-700"
                  variant="outline"
                >
                  {node.status}
                </Badge>
              </div>
              <div className="grid gap-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <MapPin className="size-4" />
                  {node.location.site} / {node.location.room}
                </div>
                <div className="flex items-center gap-2">
                  <Network className="size-4" />
                  {node.hostname} / {node.ipAddresses.join(", ")}
                </div>
                <div className="flex items-center gap-2">
                  <Cpu className="size-4" />
                  Agent {node.agentVersion} / seen {formatDateTime(node.lastSeenAt)}
                </div>
              </div>
            </div>

            <div className="grid gap-3 text-sm md:min-w-72">
              <Button
                className="justify-self-start md:justify-self-end"
                disabled={listenMutation.isPending}
                onClick={() => listenMutation.mutate(node.id)}
                variant="outline"
              >
                <Headphones className="size-4" />
                Listen
              </Button>
              <Button
                className="justify-self-start md:justify-self-end"
                disabled={rotateMutation.isPending || !isUuid(node.id)}
                onClick={() => rotateMutation.mutate(node.id)}
                title={isUuid(node.id) ? "Rotate node token" : "Demo node tokens are not persisted"}
                variant="outline"
              >
                <KeyRound className="size-4" />
                Rotate Token
              </Button>
              {node.interfaces.map((audioInterface) => (
                <div
                  className="rounded-md border border-stone-300 bg-stone-50 px-3 py-2"
                  key={audioInterface.id}
                >
                  <div className="font-medium">{audioInterface.alias}</div>
                  <div className="text-xs text-muted-foreground">
                    {audioInterface.channelCount} channels / {audioInterface.sampleRates.join(", ")}{" "}
                    Hz
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ))}
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

function setDraftValue(
  setDraft: Dispatch<SetStateAction<EnrollmentDraft>>,
  key: keyof EnrollmentDraft,
  value: EnrollmentDraft[keyof EnrollmentDraft],
) {
  setDraft((current) => ({ ...current, [key]: value }));
}

function enrollmentInput(draft: EnrollmentDraft): NodeEnrollmentInput {
  const channelCount = Number(draft.channelCount);
  const systemName = draft.systemName.trim();
  const interfaceAlias = draft.interfaceAlias.trim();
  const hasInterface = systemName || interfaceAlias || channelCount > 0;

  return {
    agentVersion: draft.agentVersion.trim(),
    alias: draft.alias.trim(),
    hostname: draft.hostname.trim(),
    interfaces: hasInterface
      ? [
          {
            alias: interfaceAlias || systemName || "Audio Interface",
            backend: draft.backend,
            channelCount: Number.isFinite(channelCount) ? Math.max(0, channelCount) : 0,
            channels: [],
            sampleRates: parseNumbers(draft.sampleRates),
            systemName: systemName || interfaceAlias || "Unknown Audio Interface",
          },
        ]
      : [],
    ipAddresses: parseList(draft.ipAddresses),
    location: {
      room: draft.room.trim(),
      site: draft.site.trim(),
    },
    notes: draft.notes.trim() || undefined,
    tags: parseList(draft.tags),
  };
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

function isUuid(value: string) {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}
