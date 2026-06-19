import { AlertTriangle, CheckCircle2, Clock3, RotateCcw, UploadCloud, XCircle } from "lucide-react";
import type { UploadQueueStatus } from "@rakkr/shared";

import { Badge } from "@/components/ui/badge";
import type { UploadQueueStatusCount } from "@/lib/recording-page-helpers";

const statusLabels: Record<UploadQueueStatus, string> = {
  cancelled: "cancelled",
  failed: "failed",
  queued: "queued",
  retrying: "retrying",
  succeeded: "succeeded",
};

const statusClasses: Record<UploadQueueStatus, string> = {
  cancelled: "border-slate-200 bg-slate-50 text-slate-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  queued: "border-sky-200 bg-sky-50 text-sky-700",
  retrying: "border-amber-200 bg-amber-50 text-amber-700",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const statusIcons = {
  cancelled: XCircle,
  failed: AlertTriangle,
  queued: Clock3,
  retrying: RotateCcw,
  succeeded: CheckCircle2,
} satisfies Record<UploadQueueStatus, typeof UploadCloud>;

export function RecordingUploadQueueSummary({ counts }: { counts: UploadQueueStatusCount[] }) {
  if (counts.length === 0) {
    return null;
  }

  const total = counts.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <UploadCloud className="size-4 text-muted-foreground" />
        <span>Upload queue</span>
        <Badge variant="secondary">{total}</Badge>
      </div>
      {counts.map((item) => {
        const Icon = statusIcons[item.status];

        return (
          <Badge className={statusClasses[item.status]} key={item.status} variant="outline">
            <Icon className="size-3" />
            {statusLabels[item.status]}
            <span className="font-mono tabular-nums">{item.count}</span>
          </Badge>
        );
      })}
    </section>
  );
}
