import { type ReactNode, useEffect, useId, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { numericInputCommit } from "@/lib/settings-updates";
import { cn } from "@/lib/utils";

// Canonical labelled form field used across every settings/policy dialog. Keep
// this the single source of truth — do not re-declare local `Field` copies, or
// label spacing drifts between dialogs.
export function Field({
  children,
  className,
  hint,
  label,
}: {
  children: ReactNode;
  className?: string;
  hint?: ReactNode;
  label: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// Canonical numeric settings field: a labelled numeric input backed by a local
// text buffer so the field stays clearable/editable while typing, but an empty
// or invalid entry never commits a value (Number("") === 0 would silently arm a
// 0 — e.g. a cleared watchdog threshold or a 0 bitrate). Shared across every
// policy/profile dialog so numeric-entry behaviour is identical everywhere
// (audit H4-2/H4-3). Re-sync from `value` only on a genuine external change.
export function NumberField({
  disabled = false,
  hint,
  label,
  max,
  min,
  onChange,
  placeholder,
  step,
  value,
}: {
  disabled?: boolean;
  hint?: ReactNode;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  placeholder?: string;
  step?: number;
  value: number;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((current) => (numericInputCommit(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Field hint={hint} label={label}>
      <Input
        disabled={disabled}
        max={max}
        min={min}
        onBlur={() =>
          setText((current) =>
            numericInputCommit(current) === undefined ? String(value) : current,
          )
        }
        onChange={(event) => {
          setText(event.target.value);
          const next = numericInputCommit(event.target.value);

          if (next !== undefined) {
            onChange(next);
          }
        }}
        placeholder={placeholder}
        step={step}
        type="number"
        value={text}
      />
    </Field>
  );
}

// Canonical boolean row: a full-width bordered control that reads as one tap
// target and highlights when checked. Shared by every policy dialog so toggles
// look identical everywhere.
export function Toggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  const checkboxId = useId();

  return (
    <label
      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg border border-input bg-transparent px-3 text-sm transition-colors select-none hover:bg-accent/50 has-data-[checked]:border-primary/40 has-data-[checked]:bg-primary/5 has-data-[disabled]:cursor-not-allowed has-data-[disabled]:opacity-60 hover:has-data-[disabled]:bg-transparent"
      htmlFor={checkboxId}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={checkboxId}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
    </label>
  );
}
