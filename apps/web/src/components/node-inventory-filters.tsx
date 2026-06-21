import type { ReactNode } from "react";
import type { NodeStatus } from "@rakkr/shared";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const nodeStatuses: NodeStatus[] = ["online", "recording", "degraded", "alerting", "offline"];
const audioBackendFilters = ["alsa", "jack", "pipewire", "unknown"] as const;
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type AudioBackendFilter = (typeof audioBackendFilters)[number];

export interface NodeInventoryFilterDraft {
  backend: "" | AudioBackendFilter;
  building: string;
  floor: string;
  room: string;
  search: string;
  site: string;
  status: "" | NodeStatus;
}

export const emptyNodeInventoryFilters: NodeInventoryFilterDraft = {
  backend: "",
  building: "",
  floor: "",
  room: "",
  search: "",
  site: "",
  status: "",
};

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
    <div className="grid w-full gap-3 md:max-w-5xl md:grid-cols-2 xl:grid-cols-7">
      <Field label="Search">
        <Input
          onChange={(event) => updateFilter("search", event.target.value)}
          placeholder="alias, room, IP, tag, serial"
          value={filters.search}
        />
      </Field>
      <Field label="Site">
        <Input
          onChange={(event) => updateFilter("site", event.target.value)}
          placeholder="site"
          value={filters.site}
        />
      </Field>
      <Field label="Building">
        <Input
          onChange={(event) => updateFilter("building", event.target.value)}
          placeholder="building"
          value={filters.building}
        />
      </Field>
      <Field label="Floor">
        <Input
          onChange={(event) => updateFilter("floor", event.target.value)}
          placeholder="floor"
          value={filters.floor}
        />
      </Field>
      <Field label="Room">
        <Input
          onChange={(event) => updateFilter("room", event.target.value)}
          placeholder="room"
          value={filters.room}
        />
      </Field>
      <Field label="Status">
        <select
          className={selectClassName}
          onChange={(event) => updateFilter("status", event.target.value as "" | NodeStatus)}
          value={filters.status}
        >
          <option value="">all statuses</option>
          {nodeStatuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Backend">
        <select
          className={selectClassName}
          onChange={(event) =>
            updateFilter("backend", event.target.value as "" | AudioBackendFilter)
          }
          value={filters.backend}
        >
          <option value="">all backends</option>
          {audioBackendFilters.map((backend) => (
            <option key={backend} value={backend}>
              {backend}
            </option>
          ))}
        </select>
      </Field>
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
