import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * A button that opens an accessible confirmation dialog before running its
 * action. Replaces ad-hoc `window.confirm` calls for destructive operations.
 */
export function ConfirmButton({
  children,
  className,
  confirmLabel = "Confirm",
  description,
  disabled,
  onConfirm,
  size,
  title,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  confirmLabel?: string;
  description?: ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
  size?: ButtonProps["size"];
  title: ReactNode;
  variant?: ButtonProps["variant"];
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button className={className} disabled={disabled} size={size} variant={variant}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={
              variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
