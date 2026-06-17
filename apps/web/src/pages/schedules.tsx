import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";

export function SchedulesPage() {
  const schedulesQuery = useQuery({
    queryFn: api.schedules,
    queryKey: ["schedules"],
  });

  return (
    <div className="grid gap-4">
      {schedulesQuery.data?.data.map((schedule) => (
        <Card className="rounded-lg p-4 shadow-sm" key={schedule.id}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock className="size-5 text-teal-700" />
                <h2 className="text-base font-semibold">{schedule.name}</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                {schedule.room} / {schedule.timezone}
              </p>
              <p className="mt-1 text-sm">
                {schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "No upcoming run"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {schedule.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
