import { useState } from "react";
import { useForm } from "react-hook-form";
import { UserPlus } from "lucide-react";
import { roles, type Role } from "@rakkr/shared";

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
  DialogTrigger,
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  appendTextLine,
  createUserDraftValid,
  emptyCreateUserDraft,
  type CreateUserDraft,
} from "@/lib/access-page-helpers";

export function AccessCreateUserDialog({
  groupOptions,
  onSubmit,
  saving,
}: {
  groupOptions: AssigneeOption[];
  onSubmit: (draft: CreateUserDraft) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<CreateUserDraft>({ defaultValues: emptyCreateUserDraft });
  const draft = form.watch();

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          form.reset(emptyCreateUserDraft);
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <UserPlus className="size-4" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Local User</DialogTitle>
          <DialogDescription>
            Provision a local account with an initial password, roles, group memberships, and
            resource scopes.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            id="access-create-user-form"
            onSubmit={form.handleSubmit((values) => onSubmit(values))}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input {...field} required type="email" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} required />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input {...field} minLength={8} required type="password" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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

            <div className="grid gap-3 md:grid-cols-2">
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
                        className="min-h-20 bg-background font-mono text-xs"
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
            </div>
          </form>
        </Form>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || !createUserDraftValid(draft)}
            form="access-create-user-form"
            type="submit"
          >
            <UserPlus className="size-4" />
            Create
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
        const checkboxId = `create-role-${role}`;

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
