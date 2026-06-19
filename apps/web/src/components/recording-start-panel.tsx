import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { useState } from "react";
import type { RecorderNode, RecordingProfile, UploadPolicy } from "@rakkr/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import {
  emptyRecordingStartDraft,
  recordingStartNodeLabel,
  startInputFromDraft,
  type RecordingStartDraft,
} from "@/lib/recording-start-helpers";

interface RecordingStartPanelProps {
  onNotice: (notice: { detail: string; title: string }) => void;
}

const emptyNodes: RecorderNode[] = [];
const emptyRecordingProfiles: RecordingProfile[] = [];
const emptyUploadPolicies: UploadPolicy[] = [];
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function RecordingStartPanel({ onNotice }: RecordingStartPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RecordingStartDraft>(emptyRecordingStartDraft);
  const nodesQuery = useQuery({
    queryFn: () => api.nodes(),
    queryKey: ["nodes"],
  });
  const recordingProfilesQuery = useQuery({
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const uploadPoliciesQuery = useQuery({
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
      onNotice({
        detail: "The ad hoc recording job was queued.",
        title: "Recording started",
      });
    },
  });
  const nodes = nodesQuery.data?.data ?? emptyNodes;
  const recordingProfiles = recordingProfilesQuery.data?.data ?? emptyRecordingProfiles;
  const uploadPolicies = uploadPoliciesQuery.data?.data ?? emptyUploadPolicies;
  const selectedNodeId = draft.nodeId || nodes[0]?.id || "";
  const selectedRecordingProfileId = draft.recordingProfileId || recordingProfiles[0]?.id || "";
  const selectedUploadPolicyId = draft.uploadPolicyId || uploadPolicies[0]?.id || "";

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm md:grid-cols-3 xl:grid-cols-6"
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
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-node">Node</Label>
        <select
          className={selectClassName}
          id="recording-start-node"
          onChange={(event) => setDraft((current) => ({ ...current, nodeId: event.target.value }))}
          value={selectedNodeId}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {recordingStartNodeLabel(node)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-profile">Profile</Label>
        <select
          className={selectClassName}
          id="recording-start-profile"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              recordingProfileId: event.target.value,
            }))
          }
          value={selectedRecordingProfileId}
        >
          {recordingProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-name">Name</Label>
        <Input
          id="recording-start-name"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          value={draft.name}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-folder">Folder</Label>
        <Input
          id="recording-start-folder"
          onChange={(event) => setDraft((current) => ({ ...current, folder: event.target.value }))}
          value={draft.folder}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-tags">Tags</Label>
        <Input
          id="recording-start-tags"
          onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
          value={draft.tags}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="recording-start-upload-policy">Upload</Label>
        <div className="flex gap-2">
          <select
            className={selectClassName}
            id="recording-start-upload-policy"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                uploadPolicyId: event.target.value,
              }))
            }
            value={selectedUploadPolicyId}
          >
            {uploadPolicies.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
          <Button
            disabled={startMutation.isPending || !selectedNodeId || !selectedRecordingProfileId}
            type="submit"
          >
            <Radio className="size-4" />
            Start
          </Button>
        </div>
      </div>
    </form>
  );
}
