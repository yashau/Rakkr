import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function NodeInventoryActions({
  allVisibleSelected,
  onClear,
  onExportSelected,
  onSelectAll,
  selectedCount,
  selectedExportPending,
}: {
  allVisibleSelected: boolean;
  onClear: () => void;
  onExportSelected: () => void;
  onSelectAll: (selected: boolean) => void;
  selectedCount: number;
  selectedExportPending: boolean;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-background p-3 md:flex-row md:items-center md:justify-between">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={allVisibleSelected}
          onCheckedChange={(value) => onSelectAll(value === true)}
        />
        <span>{selectedCount} selected</span>
      </label>
      <div className="flex flex-wrap gap-2">
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
    </div>
  );
}
