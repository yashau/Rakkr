import type { RecorderNode, ScheduleSummary } from "@rakkr/shared";

import { FilterField } from "@/components/filter-toolbar";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type SchedulePageFilterDraft } from "@/lib/schedule-page-helpers";

const captureBackends: Array<"" | NonNullable<ScheduleSummary["captureBackend"]>> = [
  "",
  "alsa",
  "jack",
  "pipewire",
];

/**
 * Secondary schedule filters rendered inside the {@link FilterToolbar}
 * slide-out. Free-text search lives inline in the toolbar.
 */
export function ScheduleFilterFields({
  filters,
  nodes,
  onChange,
}: {
  filters: SchedulePageFilterDraft;
  nodes: RecorderNode[];
  onChange: (filters: SchedulePageFilterDraft) => void;
}) {
  function updateFilter<Key extends keyof SchedulePageFilterDraft>(
    key: Key,
    value: SchedulePageFilterDraft[Key],
  ) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <>
      <FilterField label="State">
        <Select
          onValueChange={(value) =>
            updateFilter(
              "enabled",
              (value === "__all__" ? "" : value) as SchedulePageFilterDraft["enabled"],
            )
          }
          value={filters.enabled || "__all__"}
        >
          <SelectTrigger>
            <SelectValue placeholder="all states" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">all states</SelectItem>
            <SelectItem value="true">enabled</SelectItem>
            <SelectItem value="false">disabled</SelectItem>
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Node">
        {nodes.length > 0 ? (
          <Select
            onValueChange={(value) => updateFilter("nodeId", value === "__all__" ? "" : value)}
            value={filters.nodeId || "__all__"}
          >
            <SelectTrigger>
              <SelectValue placeholder="all nodes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">all nodes</SelectItem>
              {nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {node.alias}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            onChange={(event) => updateFilter("nodeId", event.target.value)}
            placeholder="node id"
            value={filters.nodeId}
          />
        )}
      </FilterField>
      <FilterField label="Backend">
        <Select
          onValueChange={(value) =>
            updateFilter(
              "captureBackend",
              (value === "__all__" ? "" : value) as SchedulePageFilterDraft["captureBackend"],
            )
          }
          value={filters.captureBackend || "__all__"}
        >
          <SelectTrigger>
            <SelectValue placeholder="all backends" />
          </SelectTrigger>
          <SelectContent>
            {captureBackends.map((backend) => (
              <SelectItem key={backend || "all"} value={backend || "__all__"}>
                {backend || "all backends"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Interface">
        <Input
          onChange={(event) => updateFilter("captureInterfaceId", event.target.value)}
          placeholder="interface id"
          value={filters.captureInterfaceId}
        />
      </FilterField>
    </>
  );
}
