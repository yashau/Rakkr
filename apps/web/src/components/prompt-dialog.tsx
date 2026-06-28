import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A small modal that collects a single (optional) text value, replacing
 * `window.prompt`. Submits the trimmed value and closes.
 */
export function PromptDialog({
  description,
  label,
  onOpenChange,
  onSubmit,
  open,
  placeholder,
  submitLabel = "Submit",
  title,
}: {
  description?: string;
  label: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => void;
  open: boolean;
  placeholder?: string;
  submitLabel?: string;
  title: string;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open) {
      setValue("");
    }
  }, [open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(value.trim());
            onOpenChange(false);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="prompt-dialog-input">{label}</Label>
            <Input
              id="prompt-dialog-input"
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              value={value}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button type="submit">{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
