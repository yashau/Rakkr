import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  recordingCacheStateOptions,
  selectClassName,
  type RecordingFilterDraft,
} from "@/lib/recording-page-helpers";

export function RecordingCacheStateFilter({
  onChange,
  value,
}: {
  onChange: (value: RecordingFilterDraft["cacheState"]) => void;
  value: RecordingFilterDraft["cacheState"];
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="recording-cache-state-filter">Cache</Label>
      <Select
        onValueChange={(next) =>
          onChange((next === "__all__" ? "" : next) as RecordingFilterDraft["cacheState"])
        }
        value={value || "__all__"}
      >
        <SelectTrigger className={selectClassName} id="recording-cache-state-filter">
          <SelectValue placeholder="Any cache" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">Any cache</SelectItem>
          {recordingCacheStateOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
