import { type ReactNode, useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
