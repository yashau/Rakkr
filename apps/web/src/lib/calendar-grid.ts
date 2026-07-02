// Pure date/grid helpers for the schedule calendar. The grid and occurrence
// grouping are browser-local (the calendar shows local days); occurrence starts
// arrive as UTC ISO and are bucketed by their local day.

export interface CalendarDayCell {
  date: Date;
  inMonth: boolean;
  iso: string;
  isToday: boolean;
}

export const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function localDayIso(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// Monday-first weekday index (0 = Monday … 6 = Sunday).
function mondayIndex(date: Date) {
  return (date.getDay() + 6) % 7;
}

// A fixed 6-week (42-day) grid starting on the Monday on/before the 1st.
export function buildMonthGrid(year: number, month: number, today = new Date()): CalendarDayCell[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - mondayIndex(first));
  const todayIso = localDayIso(today);
  const weeks: CalendarDayCell[][] = [];

  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDayCell[] = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const offset = week * 7 + weekday;
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
      const iso = localDayIso(date);

      days.push({ date, inMonth: date.getMonth() === month, iso, isToday: iso === todayIso });
    }

    weeks.push(days);
  }

  return weeks;
}

// The [start, end] instants spanning the whole visible grid, for the API window.
export function monthGridRange(year: number, month: number) {
  const grid = buildMonthGrid(year, month);
  const first = grid[0][0].date;
  const last = grid[grid.length - 1][6].date;

  return {
    end: new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999),
    start: new Date(first.getFullYear(), first.getMonth(), first.getDate(), 0, 0, 0, 0),
  };
}

export function groupByLocalDay<T extends { recordingStartAt: string }>(occurrences: T[]) {
  const map = new Map<string, T[]>();

  for (const occurrence of occurrences) {
    const iso = localDayIso(new Date(occurrence.recordingStartAt));
    const bucket = map.get(iso);

    if (bucket) {
      bucket.push(occurrence);
    } else {
      map.set(iso, [occurrence]);
    }
  }

  return map;
}

// New UTC ISO start for a dragged occurrence: keep its local time-of-day, move
// it onto the target local day.
export function moveStartToDay(originalStartIso: string, targetDayIso: string) {
  const original = new Date(originalStartIso);
  const [year, month, day] = targetDayIso.split("-").map(Number);
  const moved = new Date(
    year,
    (month ?? 1) - 1,
    day ?? 1,
    original.getHours(),
    original.getMinutes(),
    original.getSeconds(),
    original.getMilliseconds(),
  );

  return moved.toISOString();
}

export function addMonths(year: number, month: number, delta: number) {
  const base = new Date(year, month + delta, 1);

  return { month: base.getMonth(), year: base.getFullYear() };
}

export function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(year, month, 1),
  );
}

export function timeLabel(iso: string) {
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${lookup.hour ?? "00"}:${lookup.minute ?? "00"}`;
}
