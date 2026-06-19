function partMap(date: Date) {
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function datePartMap(date: Date) {
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatDateTime(value: Date | string) {
  const parts = partMap(dateFromValue(value));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatDate(value: Date | string) {
  const parts = datePartMap(dateFromValue(value));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

export function isoFromLocalDateTime(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

export function localDateBoundaryIso(value: string, boundary: "end" | "start") {
  if (!value) {
    return undefined;
  }

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return undefined;
  }

  const date =
    boundary === "start"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999);

  return date.toISOString();
}

export function localDateTimeInput(value: string | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

export function localIsoDate(value: Date) {
  return formatDate(value);
}

export function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateFromValue(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
