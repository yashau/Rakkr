import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Save } from "lucide-react";
import type {
  AccessGroupCreateRequest,
  AccessGroupSummary,
  AccessGroupUpdateRequest,
} from "@rakkr/shared";

import type { AssigneeOption } from "@/components/assignee-multi-select";
import { UserMultiSelect } from "@/components/user-multi-select";
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
import { Textarea } from "@/components/ui/textarea";

interface GroupFormDraft {
  description: string;
  memberIds: string[];
  name: string;
}

// Create + edit dialog for an access group. Membership is only set on create here;
// existing groups manage members through the dedicated members dialog (PATCH vs PUT).
export function AccessGroupFormDialog({
  group,
  onOpenChange,
  onSubmitCreate,
  onSubmitUpdate,
  open,
  saving,
  userOptions,
}: {
  group: AccessGroupSummary | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmitCreate: (input: AccessGroupCreateRequest) => void;
  onSubmitUpdate: (groupId: string, input: AccessGroupUpdateRequest) => void;
  open: boolean;
  saving: boolean;
  userOptions: AssigneeOption[];
}) {
  const isEdit = Boolean(group);
  const form = useForm<GroupFormDraft>({
    defaultValues: { description: "", memberIds: [], name: "" },
  });
  const name = form.watch("name");

  useEffect(() => {
    if (open) {
      // Membership is edited via the dedicated members dialog, so the create form
      // always starts empty; edit mode ignores this field.
      form.reset({
        description: group?.description ?? "",
        memberIds: [],
        name: group?.name ?? "",
      });
    }
  }, [form, group, open]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Group" : "Create Access Group"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Rename or describe this access group. Manage its members from the group's Members action."
              : "Create an access group, then assign it to schedules, room rosters, and access policies."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            id="access-group-form"
            onSubmit={form.handleSubmit((values) => {
              const trimmedName = values.name.trim();
              const trimmedDescription = values.description.trim();

              if (!trimmedName) {
                return;
              }

              if (group) {
                onSubmitUpdate(group.id, {
                  description: trimmedDescription ? trimmedDescription : null,
                  name: trimmedName,
                });
              } else {
                onSubmitCreate({
                  description: trimmedDescription || undefined,
                  memberIds: values.memberIds,
                  name: trimmedName,
                });
              }
            })}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Room Operators" required />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      className="min-h-16 bg-background"
                      placeholder="Optional — who this group is for"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isEdit ? null : (
              <FormField
                control={form.control}
                name="memberIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Members</FormLabel>
                    <FormControl>
                      <UserMultiSelect
                        onChange={field.onChange}
                        selectedUserIds={field.value}
                        userOptions={userOptions}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </form>
        </Form>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={saving || !name.trim()} form="access-group-form" type="submit">
            <Save className="size-4" />
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
