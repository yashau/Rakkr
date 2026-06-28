import type { ReactNode } from "react";
import { RotateCcw, X } from "lucide-react";
import type { RecorderNode, ScheduleSummary } from "@rakkr/shared";

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
import {
  emptySchedulePageFilters,
  scheduleFilterChips,
  scheduleFiltersFromDraft,
  type ScheduleFilterKey,
  type SchedulePageFilterDraft,
} from "@/lib/schedule-page-helpers";

const captureBackends: Array<"" | NonNullable<ScheduleSummary["captureBackend"]>> = [
  "",
  "alsa",
  "jack",
  "pipewire",
];
const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const scheduleFilterDraftKeys: Record<ScheduleFilterKey, keyof SchedulePageFilterDraft> = {
  captureBackend: "captureBackend",
  captureInterfaceId: "captureInterfaceId",
  enabled: "enabled",
  nodeId: "nodeId",
  search: "search",
};

export function ScheduleFiltersPanel({
  filters,
  nodes,
  onChange,
  shownCount,
}: {
  filters: SchedulePageFilterDraft;
  nodes: RecorderNode[];
  onChange: (filters: SchedulePageFilterDraft) => void;
  shownCount: number;
}) {
  const activeFilters = scheduleFilterChips(scheduleFiltersFromDraft(filters));

  return (
    <section className="rounded-lg border border-border bg-panel p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-sm font-semibold">Schedule Filters</h2>
          <p className="text-xs text-muted-foreground">{shownCount} shown</p>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <FilterField label="Search">
            <Input
              onChange={(event) => updateFilter("search", event.target.value)}
              placeholder="name, room, tag, policy"
              value={filters.search}
            />
          </FilterField>
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
              <SelectTrigger className={selectClass}>
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
                <SelectTrigger className={selectClass}>
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
              <SelectTrigger className={selectClass}>
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
        </div>
        <Button onClick={() => onChange(emptySchedulePageFilters)} type="button" variant="outline">
          <RotateCcw className="size-4" />
          Reset
        </Button>
      </div>
      {activeFilters.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {activeFilters.map((filter) => (
            <Badge
              className="max-w-full gap-1 overflow-hidden bg-background pr-1"
              key={filter.key}
              variant="outline"
            >
              <span className="shrink-0 text-muted-foreground">{filter.label}</span>
              <span className="truncate font-mono">{filter.value}</span>
              <button
                aria-label={`Clear ${filter.label} filter`}
                className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => clearFilter(filter.key)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            className="h-6 px-2 text-xs"
            onClick={() => onChange(emptySchedulePageFilters)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </section>
  );

  function updateFilter<Key extends keyof SchedulePageFilterDraft>(
    key: Key,
    value: SchedulePageFilterDraft[Key],
  ) {
    onChange({ ...filters, [key]: value });
  }

  function clearFilter(key: ScheduleFilterKey) {
    onChange({ ...filters, [scheduleFilterDraftKeys[key]]: "" });
  }
}

function FilterField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
