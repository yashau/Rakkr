import { Label } from "@/components/ui/label";
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
      <select
        className={selectClassName}
        id="recording-cache-state-filter"
        onChange={(event) => onChange(event.target.value as RecordingFilterDraft["cacheState"])}
        value={value}
      >
        <option value="">Any cache</option>
        {recordingCacheStateOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
