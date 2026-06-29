import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { KeyRound } from "lucide-react";
import type { CurrentUser } from "@rakkr/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface ResetPasswordForm {
  password: string;
}

export function AccessResetPasswordDialog({
  onOpenChange,
  onSubmit,
  open,
  saving,
  user,
}: {
  onOpenChange: (open: boolean) => void;
  onSubmit: (userId: string, password: string) => void;
  open: boolean;
  saving: boolean;
  user: CurrentUser | undefined;
}) {
  const form = useForm<ResetPasswordForm>({ defaultValues: { password: "" } });
  const password = form.watch("password");

  // Clear the field each time the dialog opens so a previous user's draft never
  // carries over.
  useEffect(() => {
    if (open) {
      form.reset({ password: "" });
    }
  }, [form, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            {user ? `Set a new password for ${user.name}.` : "Set a new password for this account."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            id="access-reset-password-form"
            onSubmit={form.handleSubmit((values) => {
              if (user) {
                onSubmit(user.id, values.password);
              }
            })}
          >
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New password</FormLabel>
                  <FormControl>
                    <Input {...field} minLength={8} required type="password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || !user || password.length < 8}
            form="access-reset-password-form"
            type="submit"
          >
            <KeyRound className="size-4" />
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
