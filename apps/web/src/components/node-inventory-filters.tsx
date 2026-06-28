import type { ReactNode } from "react";
import type { NodeStatus } from "@rakkr/shared";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const nodeStatuses: NodeStatus[] = ["online", "recording", "degraded", "alerting", "offline"];
const audioBackendFilters = ["alsa", "jack", "pipewire", "unknown"] as const;
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

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
    <div className="grid w-full gap-3 md:max-w-6xl md:grid-cols-2 xl:grid-cols-9">
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
      <Field label="Last Seen From">
        <Input
          onChange={(event) => updateFilter("lastSeenFrom", event.target.value)}
          type="date"
          value={filters.lastSeenFrom}
        />
      </Field>
      <Field label="Last Seen To">
        <Input
          onChange={(event) => updateFilter("lastSeenTo", event.target.value)}
          type="date"
          value={filters.lastSeenTo}
        />
      </Field>
      <Field label="Status">
        <Select
          onValueChange={(value) =>
            updateFilter("status", (value === "__all__" ? "" : value) as "" | NodeStatus)
          }
          value={filters.status || "__all__"}
        >
          <SelectTrigger className={selectClassName}>
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
      </Field>
      <Field label="Backend">
        <Select
          onValueChange={(value) =>
            updateFilter("backend", (value === "__all__" ? "" : value) as "" | AudioBackendFilter)
          }
          value={filters.backend || "__all__"}
        >
          <SelectTrigger className={selectClassName}>
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
