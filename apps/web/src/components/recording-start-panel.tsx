import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { useState } from "react";
import type { AudioInterface, RecorderNode, RecordingProfile, UploadPolicy } from "@rakkr/shared";

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
import { api } from "@/lib/api";
import {
  emptyRecordingStartDraft,
  recordingStartNodeLabel,
  startInputFromDraft,
  type RecordingStartDraft,
} from "@/lib/recording-start-helpers";

interface RecordingStartPanelProps {
  canReadNodes: boolean;
  canReadSettings: boolean;
  fixedNodeId?: string;
  onNotice: (notice: { detail: string; title: string }) => void;
}

const emptyNodes: RecorderNode[] = [];
const emptyRecordingProfiles: RecordingProfile[] = [];
const emptyUploadPolicies: UploadPolicy[] = [];
const captureBackends: RecordingStartDraft["captureBackend"][] = ["", "alsa", "jack", "pipewire"];
const selectClassName =
  "flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm whitespace-nowrap text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>span]:line-clamp-1 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis";

export function RecordingStartPanel({
  canReadNodes,
  canReadSettings,
  fixedNodeId = "",
  onNotice,
}: RecordingStartPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RecordingStartDraft>(emptyRecordingStartDraft);
  const nodesQuery = useQuery({
    enabled: canReadNodes,
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const recordingProfilesQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const uploadPoliciesQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.uploadPolicies,
    queryKey: ["upload-policies"],
  });
  const startMutation = useMutation({
    mutationFn: api.startRecording,
    onError: () =>
      onNotice({
        detail: "The selected node could not start an ad hoc recording.",
        title: "Start failed",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-facets"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
      onNotice({
        detail: "The ad hoc recording job was queued.",
        title: "Recording started",
      });
    },
  });
  const nodes = nodesQuery.data?.data ?? emptyNodes;
  const recordingProfiles = recordingProfilesQuery.data?.data ?? emptyRecordingProfiles;
  const uploadPolicies = uploadPoliciesQuery.data?.data ?? emptyUploadPolicies;
  const fixedNode = nodes.find((node) => node.id === fixedNodeId);
  const selectedNodeId = fixedNode?.id || draft.nodeId || nodes[0]?.id || "";
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedRecordingProfileId = draft.recordingProfileId || recordingProfiles[0]?.id || "";
  const selectedUploadPolicyId = draft.uploadPolicyId || uploadPolicies[0]?.id || "";

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        startMutation.mutate(
          startInputFromDraft({
            ...draft,
            nodeId: selectedNodeId,
            recordingProfileId: selectedRecordingProfileId,
            uploadPolicyId: selectedUploadPolicyId,
          }),
        );
      }}
    >
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-8">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-node">Node</Label>
          <Select
            disabled={Boolean(fixedNode)}
            onValueChange={(value) => {
              const nextNode = nodes.find((node) => node.id === value);

              setDraft((current) => ({
                ...current,
                captureInterfaceId: nextNode?.interfaces.some(
                  (candidate) => candidate.id === current.captureInterfaceId,
                )
                  ? current.captureInterfaceId
                  : "",
                nodeId: value,
              }));
            }}
            value={selectedNodeId}
          >
            <SelectTrigger className={selectClassName} id="recording-start-node">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {recordingStartNodeLabel(node)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-backend">Backend</Label>
          <Select
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                captureBackend: (value === "__all__"
                  ? ""
                  : value) as RecordingStartDraft["captureBackend"],
              }))
            }
            value={draft.captureBackend || "__all__"}
          >
            <SelectTrigger className={selectClassName} id="recording-start-backend">
              <SelectValue placeholder="Node default" />
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
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-interface">Interface</Label>
          <Select
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                captureInterfaceId: value === "__all__" ? "" : value,
              }))
            }
            value={draft.captureInterfaceId || "__all__"}
          >
            <SelectTrigger className={selectClassName} id="recording-start-interface">
              <SelectValue placeholder="Node default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Node default</SelectItem>
              {selectedNode?.interfaces.map((audioInterface) => (
                <SelectItem key={audioInterface.id} value={audioInterface.id}>
                  {recordingStartInterfaceLabel(audioInterface)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-profile">Profile</Label>
          <Select
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                recordingProfileId: value,
              }))
            }
            value={selectedRecordingProfileId}
          >
            <SelectTrigger className={selectClassName} id="recording-start-profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {recordingProfiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-name">Name</Label>
          <Input
            id="recording-start-name"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            value={draft.name}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-folder">Folder</Label>
          <Input
            id="recording-start-folder"
            onChange={(event) =>
              setDraft((current) => ({ ...current, folder: event.target.value }))
            }
            value={draft.folder}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-tags">Tags</Label>
          <Input
            id="recording-start-tags"
            onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
            value={draft.tags}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="recording-start-upload-policy">Upload</Label>
          <Select
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                uploadPolicyId: value,
              }))
            }
            value={selectedUploadPolicyId}
          >
            <SelectTrigger className={selectClassName} id="recording-start-upload-policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {uploadPolicies.map((policy) => (
                <SelectItem key={policy.id} value={policy.id}>
                  {policy.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={
            startMutation.isPending ||
            !canReadNodes ||
            !canReadSettings ||
            !selectedNodeId ||
            !selectedRecordingProfileId
          }
          type="submit"
        >
          <Radio className="size-4" />
          Start
        </Button>
      </div>
    </form>
  );
}

function recordingStartInterfaceLabel(audioInterface: AudioInterface) {
  return `${audioInterface.alias} / ${audioInterface.systemName} / ${audioInterface.backend}`;
}
