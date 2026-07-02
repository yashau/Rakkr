import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Save } from "lucide-react";
import { roles, type CurrentUser, type Role } from "@rakkr/shared";

import type { AssigneeOption } from "@/components/assignee-multi-select";
import { GroupMultiSelect } from "@/components/group-multi-select";
import { ResourceGrantComposer } from "@/components/resource-grant-composer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { accessDraftFromUser, appendTextLine, type AccessDraft } from "@/lib/access-page-helpers";

export function AccessEditDialog({
  groupOptions,
  onOpenChange,
  onSubmit,
  open,
  saving,
  user,
}: {
  groupOptions: AssigneeOption[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (userId: string, draft: AccessDraft) => void;
  open: boolean;
  saving: boolean;
  user: CurrentUser | undefined;
}) {
  const form = useForm<AccessDraft>({
    defaultValues: { groupIds: [], grantsText: "", roles: [] },
  });

  // Reseed the form whenever the dialog opens for a (possibly different) user so
  // stale roles/groups/scopes never leak between rows.
  useEffect(() => {
    if (open && user) {
      form.reset(accessDraftFromUser(user));
    }
  }, [form, open, user]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Access</DialogTitle>
          <DialogDescription>
            {user
              ? `Update roles, group memberships, and resource scopes for ${user.name}.`
              : "Update roles, group memberships, and resource scopes."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            id="access-edit-form"
            onSubmit={form.handleSubmit((values) => {
              if (user) {
                onSubmit(user.id, values);
              }
            })}
          >
            <FormField
              control={form.control}
              name="roles"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Roles</FormLabel>
                  <FormControl>
                    <RolePicker onChange={field.onChange} rolesValue={field.value} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="groupIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Groups</FormLabel>
                  <FormControl>
                    <GroupMultiSelect
                      groupOptions={groupOptions}
                      onChange={field.onChange}
                      selectedGroupIds={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="grantsText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Scopes</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      className="min-h-32 bg-background font-mono text-xs"
                      placeholder="node:node_x32_test"
                    />
                  </FormControl>
                  <ResourceGrantComposer
                    onAppend={(line) =>
                      form.setValue("grantsText", appendTextLine(field.value, line))
                    }
                  />
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
          <Button disabled={saving || !user} form="access-edit-form" type="submit">
            <Save className="size-4" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RolePicker({
  onChange,
  rolesValue,
}: {
  onChange: (rolesValue: Role[]) => void;
  rolesValue: Role[];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((role) => {
        const checkboxId = `edit-role-${role}`;

        return (
          <Label
            className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-normal"
            htmlFor={checkboxId}
            key={role}
          >
            <Checkbox
              checked={rolesValue.includes(role)}
              id={checkboxId}
              onCheckedChange={(value) =>
                onChange(
                  value === true
                    ? [...rolesValue, role]
                    : rolesValue.filter((current) => current !== role),
                )
              }
            />
            {role}
          </Label>
        );
      })}
    </div>
  );
}
