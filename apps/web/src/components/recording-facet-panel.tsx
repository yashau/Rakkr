import type { LucideIcon } from "lucide-react";
import { CloudUpload, Folder, Layers, Server, Settings2, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RecordingFacet } from "@/lib/api";

interface RecordingFacetPanelProps {
  folders: RecordingFacet[];
  nodes: RecordingFacet[];
  onFolder: (value: string) => void;
  onNode: (value: string) => void;
  onRecordingProfile: (value: string) => void;
  onTag: (value: string) => void;
  onTrackGroup: (value: string) => void;
  onUploadPolicy: (value: string) => void;
  recordingProfiles: RecordingFacet[];
  tags: RecordingFacet[];
  trackGroups: RecordingFacet[];
  uploadPolicies: RecordingFacet[];
}

interface RecordingFacetGroup {
  icon: LucideIcon;
  items: RecordingFacet[];
  label: string;
  onSelect: (value: string) => void;
}

export function RecordingFacetPanel({
  folders,
  nodes,
  onFolder,
  onNode,
  onRecordingProfile,
  onTag,
  onTrackGroup,
  onUploadPolicy,
  recordingProfiles,
  tags,
  trackGroups,
  uploadPolicies,
}: RecordingFacetPanelProps) {
  const groups: RecordingFacetGroup[] = [
    { icon: Folder, items: folders, label: "Folders", onSelect: onFolder },
    { icon: Tag, items: tags, label: "Tags", onSelect: onTag },
    { icon: Server, items: nodes, label: "Nodes", onSelect: onNode },
    {
      icon: Settings2,
      items: recordingProfiles,
      label: "Profiles",
      onSelect: onRecordingProfile,
    },
    {
      icon: CloudUpload,
      items: uploadPolicies,
      label: "Upload Policies",
      onSelect: onUploadPolicy,
    },
    { icon: Layers, items: trackGroups, label: "Track Groups", onSelect: onTrackGroup },
  ].filter((group) => group.items.length > 0);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <FacetGroup group={group} key={group.label} />
      ))}
    </div>
  );
}

function FacetGroup({ group }: { group: RecordingFacetGroup }) {
  const Icon = group.icon;

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="size-4" />
        {group.label}
      </div>
      <div className="flex flex-wrap gap-2">
        {group.items.map((item) => (
          <Button
            className="max-w-full overflow-hidden"
            key={item.value}
            onClick={() => group.onSelect(item.value)}
            size="sm"
            type="button"
            variant="outline"
          >
            <span className="truncate">{item.value}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{item.count}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
