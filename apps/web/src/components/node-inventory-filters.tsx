import type { NodeStatus } from "@rakkr/shared";

import { FilterField } from "@/components/filter-toolbar";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Every node status is filterable, including `provisioning` (enrolled but never
// contacted) so operators can review the just-onboarded cohort (audit H1-2).
export const nodeStatuses: NodeStatus[] = [
  "provisioning",
  "online",
  "recording",
  "degraded",
  "alerting",
  "offline",
];
const audioBackendFilters = ["alsa", "jack", "pipewire", "unknown"] as const;

export type AudioBackendFilter = (typeof audioBackendFilters)[number];

export interface NodeInventoryFilterDraft {
  backend: "" | AudioBackendFilter;
  building: string;
  floor: string;
  lastSeenFrom: string;
  lastSeenTo: string;
  room: string;
  search: string;
  site: string;
  status: "" | NodeStatus;
}

export const emptyNodeInventoryFilters: NodeInventoryFilterDraft = {
  backend: "",
  building: "",
  floor: "",
  lastSeenFrom: "",
  lastSeenTo: "",
  room: "",
  search: "",
  site: "",
  status: "",
};

/**
 * Secondary node filters rendered inside the {@link FilterToolbar} slide-out.
 * Free-text search lives inline in the toolbar, so it is intentionally absent
 * here.
 */
export function NodeInventoryFilters({
  filters,
  onChange,
}: {
  filters: NodeInventoryFilterDraft;
  onChange: (filters: NodeInventoryFilterDraft) => void;
}) {
  function updateFilter<Key extends keyof NodeInventoryFilterDraft>(
    key: Key,
    value: NodeInventoryFilterDraft[Key],
  ) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <>
      <FilterField label="Status">
        <Select
          onValueChange={(value) =>
            updateFilter("status", (value === "__all__" ? "" : value) as "" | NodeStatus)
          }
          value={filters.status || "__all__"}
        >
          <SelectTrigger>
            <SelectValue placeholder="all statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">all statuses</SelectItem>
            {nodeStatuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Backend">
        <Select
          onValueChange={(value) =>
            updateFilter("backend", (value === "__all__" ? "" : value) as "" | AudioBackendFilter)
          }
          value={filters.backend || "__all__"}
        >
          <SelectTrigger>
            <SelectValue placeholder="all backends" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">all backends</SelectItem>
            {audioBackendFilters.map((backend) => (
              <SelectItem key={backend} value={backend}>
                {backend}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>
      <FilterField label="Site">
        <Input
          onChange={(event) => updateFilter("site", event.target.value)}
          placeholder="site"
          value={filters.site}
        />
      </FilterField>
      <FilterField label="Building">
        <Input
          onChange={(event) => updateFilter("building", event.target.value)}
          placeholder="building"
          value={filters.building}
        />
      </FilterField>
      <FilterField label="Floor">
        <Input
          onChange={(event) => updateFilter("floor", event.target.value)}
          placeholder="floor"
          value={filters.floor}
        />
      </FilterField>
      <FilterField label="Room">
        <Input
          onChange={(event) => updateFilter("room", event.target.value)}
          placeholder="room"
          value={filters.room}
        />
      </FilterField>
      <FilterField label="Last Seen From">
        <DatePicker
          aria-label="Last seen from"
          onChange={(value) => updateFilter("lastSeenFrom", value)}
          value={filters.lastSeenFrom}
        />
      </FilterField>
      <FilterField label="Last Seen To">
        <DatePicker
          aria-label="Last seen to"
          onChange={(value) => updateFilter("lastSeenTo", value)}
          value={filters.lastSeenTo}
        />
      </FilterField>
    </>
  );
}
