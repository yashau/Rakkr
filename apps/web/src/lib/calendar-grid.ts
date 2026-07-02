// Pure date/grid helpers for the schedule calendar. The grid and occurrence
// grouping are browser-local (the calendar shows local days); occurrence starts
// arrive as UTC ISO and are bucketed by their local day.

export interface CalendarDayCell {
  date: Date;
  inMonth: boolean;
  iso: string;
  isToday: boolean;
}

// Sunday-first base labels, indexed by JS Date.getDay() (0 = Sunday).
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const WEEK_START_INDEXES: Record<string, number> = {
  friday: 5,
  monday: 1,
  saturday: 6,
  sunday: 0,
  thursday: 4,
  tuesday: 2,
  wednesday: 3,
};

// Maps a controller-settings week-start day name to the JS getDay() index
// buildMonthGrid/monthGridRange/orderedWeekdayLabels expect. Defaults to
// Monday (1) for an unset or unrecognized value.
export function weekStartIndex(day: string | undefined): number {
  return day !== undefined && day in WEEK_START_INDEXES ? WEEK_START_INDEXES[day] : 1;
}

// Weekday header labels ordered so the configured start day comes first.
// weekStartsOn is a JS getDay() index (0 = Sunday … 6 = Saturday).
export function orderedWeekdayLabels(weekStartsOn: number) {
  const start = ((weekStartsOn % 7) + 7) % 7;

  return Array.from({ length: 7 }, (_, index) => WEEKDAY_LABELS[(start + index) % 7]);
}

export function localDayIso(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// Offset of `date` from the configured week-start day (0 … 6).
function weekdayOffset(date: Date, weekStartsOn: number) {
  return (((date.getDay() - weekStartsOn) % 7) + 7) % 7;
}

// A fixed 6-week (42-day) grid whose first column is `weekStartsOn`, starting on
// that weekday on/before the 1st of the month.
export function buildMonthGrid(
  year: number,
  month: number,
  weekStartsOn = 1,
  today = new Date(),
): CalendarDayCell[][] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - weekdayOffset(first, weekStartsOn));
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
export function monthGridRange(year: number, month: number, weekStartsOn = 1) {
  const grid = buildMonthGrid(year, month, weekStartsOn);
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
