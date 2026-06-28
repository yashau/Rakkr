import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function NodeInventoryActions({
  allVisibleSelected,
  exportPending,
  onClear,
  onExport,
  onExportSelected,
  onSelectAll,
  selectedCount,
  selectedExportPending,
}: {
  allVisibleSelected: boolean;
  exportPending: boolean;
  onClear: () => void;
  onExport: () => void;
  onExportSelected: () => void;
  onSelectAll: (selected: boolean) => void;
  selectedCount: number;
  selectedExportPending: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={allVisibleSelected}
          onCheckedChange={(value) => onSelectAll(value === true)}
        />
        <span>{selectedCount} selected</span>
      </label>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button disabled={exportPending} onClick={onExport} variant="outline">
              <Download className="size-4" />
              Export
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Export filtered node inventory</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              disabled={selectedCount === 0 || selectedExportPending}
              onClick={onExportSelected}
              variant="outline"
            >
              <Download className="size-4" />
              Export selected
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {selectedCount > 0 ? "Export selected visible nodes" : "Select visible nodes to export"}
        </TooltipContent>
      </Tooltip>
      <Button disabled={selectedCount === 0} onClick={onClear} variant="outline">
        Clear
      </Button>
    </div>
  );
}
