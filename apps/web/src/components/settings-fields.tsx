import { type ReactNode, useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Toggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const checkboxId = useId();

  return (
    <label
      className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm"
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
