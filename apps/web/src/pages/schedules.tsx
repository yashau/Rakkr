import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CalendarPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const schedulesQuery = useQuery({
    queryFn: api.schedules,
    queryKey: ["schedules"],
  });
  const runNowMutation = useMutation({
    mutationFn: api.runScheduleNow,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
    },
  });

  return (
    <div className="grid gap-4">
      {schedulesQuery.data?.data.map((schedule) => (
        <Card className="rounded-lg p-4 shadow-sm" key={schedule.id}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock className="size-5 text-teal-700" />
                <h2 className="text-base font-semibold">{schedule.name}</h2>
                <Badge variant={schedule.enabled ? "secondary" : "outline"}>
                  {schedule.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {schedule.room} / {schedule.timezone}
              </p>
              <p className="mt-1 text-sm">
                {schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "No upcoming run"}
              </p>
              <dl className="mt-3 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
                <div>
                  <dt className="font-medium text-foreground">Title</dt>
                  <dd>{schedule.titleTemplate}</dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">Folder</dt>
                  <dd>{schedule.folderTemplate}</dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">Profile</dt>
                  <dd>{schedule.recordingProfileId}</dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">Watchdog</dt>
                  <dd>{schedule.watchdogPolicyId}</dd>
                </div>
              </dl>
            </div>
            <div className="grid gap-3 md:justify-items-end">
              <Button
                disabled={runNowMutation.isPending || !schedule.enabled}
                onClick={() => runNowMutation.mutate(schedule.id)}
                variant="outline"
              >
                <CalendarPlus className="size-4" />
                Run Now
              </Button>
              <div className="flex flex-wrap gap-2 md:justify-end">
                {schedule.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </Card>
      ))}
      {runNowMutation.isError ? (
        <p className="text-sm text-destructive">Schedule run failed.</p>
      ) : null}
    </div>
  );
}
