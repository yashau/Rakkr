import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

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
        <input
          checked={allVisibleSelected}
          className="size-4"
          onChange={(event) => onSelectAll(event.target.checked)}
          type="checkbox"
        />
        <span>{selectedCount} selected</span>
      </label>
      <Button
        disabled={exportPending}
        onClick={onExport}
        title="Export filtered node inventory"
        variant="outline"
      >
        <Download className="size-4" />
        Export
      </Button>
      <Button
        disabled={selectedCount === 0 || selectedExportPending}
        onClick={onExportSelected}
        title={
          selectedCount > 0 ? "Export selected visible nodes" : "Select visible nodes to export"
        }
        variant="outline"
      >
        <Download className="size-4" />
        Export selected
      </Button>
      <Button disabled={selectedCount === 0} onClick={onClear} variant="outline">
        Clear
      </Button>
    </div>
  );
}
