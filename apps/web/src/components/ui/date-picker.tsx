import { Calendar as CalendarIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

// Parse a "YYYY-MM-DD" string into a local Date without timezone shifting.
function parseDateValue(value: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) {
    return undefined;
  }

  const date = new Date(year, month - 1, day);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

export interface DatePickerProps {
  "aria-label"?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // ISO calendar date string, e.g. "2026-06-29", or "" when unset.
  value: string;
}

export function DatePicker({
  "aria-label": ariaLabel,
  className,
  disabled,
  id,
  onChange,
  placeholder = "Pick a date",
  value,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseDateValue(value);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className={cn(
            "w-full justify-start text-left font-normal",
            !selected && "text-muted-foreground",
            className,
          )}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
        >
          <CalendarIcon className="size-4 shrink-0" />
          <span className="truncate">{selected ? formatDate(selected) : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          onSelect={(date) => {
            onChange(date ? formatDate(date) : "");
            setOpen(false);
          }}
          selected={selected}
        />
        {selected ? (
          <div className="border-t border-border p-2">
            <Button
              className="w-full"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function splitDateTime(value: string): { date: string; time: string } {
  if (!value) {
    return { date: "", time: "" };
  }

  const [date, time = ""] = value.split("T");

  return { date, time: time.slice(0, 5) };
}

export interface DateTimePickerProps {
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  required?: boolean;
  // Local datetime string, e.g. "2026-06-29T14:30", or "" when unset.
  value: string;
}

export function DateTimePicker({
  className,
  disabled,
  id,
  onChange,
  required,
  value,
}: DateTimePickerProps) {
  const { date, time } = splitDateTime(value);

  function emit(nextDate: string, nextTime: string) {
    if (!nextDate) {
      onChange("");
      return;
    }

    onChange(`${nextDate}T${nextTime || "00:00"}`);
  }

  return (
    <div className={cn("flex gap-2", className)}>
      <DatePicker
        className="min-w-0 flex-1"
        disabled={disabled}
        id={id}
        onChange={(nextDate) => emit(nextDate, time)}
        value={date}
      />
      <Input
        aria-label="Time"
        className="w-28"
        disabled={disabled}
        onChange={(event) => emit(date, event.target.value)}
        required={required}
        type="time"
        value={time}
      />
    </div>
  );
}
