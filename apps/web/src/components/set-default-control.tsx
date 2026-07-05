import { Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toneBadgeClass } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

/**
 * "Default" marker shown beside the name of the policy/profile that pre-fills
 * scheduling and ad-hoc recording. Shared by every settings section so the
 * badge reads identically across recording profiles, watchdog, retention, and
 * upload policies.
 */
export function DefaultBadge() {
  return (
    <Badge className={cn(toneBadgeClass("info"), "gap-1")} variant="outline">
      <Star className="size-3 fill-current" />
      Default
    </Badge>
  );
}

/**
 * Toggle a policy as the default for its type. Selecting a policy that is
 * already the default clears it (there is at most one default per type).
 */
export function SetDefaultButton({
  canManage,
  isDefault,
  isPending,
  onToggle,
}: {
  canManage: boolean;
  isDefault: boolean;
  isPending: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-pressed={isDefault}
      disabled={!canManage || isPending}
      onClick={onToggle}
      size="sm"
      title={isDefault ? "Clear default" : "Set as the scheduling/ad-hoc default"}
      type="button"
      variant={isDefault ? "secondary" : "ghost"}
    >
      <Star className={cn("size-4", isDefault && "fill-current")} />
      {isDefault ? "Default" : "Set default"}
    </Button>
  );
}
