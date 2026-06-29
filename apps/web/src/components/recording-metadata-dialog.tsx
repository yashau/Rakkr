import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Save } from "lucide-react";
import type { RecordingSummary } from "@rakkr/shared";

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
import type { RecordingMetadataUpdate } from "@/lib/api";
import {
  tagsFromText,
  tagsToText,
  transcriptSnippetsFromText,
  transcriptSnippetsToText,
} from "@/lib/recording-page-helpers";

interface RecordingMetadataDraft {
  folder: string;
  name: string;
  notes: string;
  tags: string;
  transcriptSnippets: string;
}

export function RecordingMetadataDialog({
  onOpenChange,
  onSubmit,
  open,
  recording,
  saving,
}: {
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: RecordingMetadataUpdate) => Promise<unknown>;
  open: boolean;
  recording: RecordingSummary | undefined;
  saving: boolean;
}) {
  const form = useForm<RecordingMetadataDraft>({
    defaultValues: emptyDraft,
  });

  // Reseed the form whenever the dialog opens for a (possibly different)
  // recording so stale metadata never leaks between cards.
  useEffect(() => {
    if (open && recording) {
      form.reset(draftFromRecording(recording));
    }
  }, [form, open, recording]);

  const name = form.watch("name");
  const folder = form.watch("folder");
  const saveDisabled = saving || !recording || !name.trim() || !folder.trim();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Recording</DialogTitle>
          <DialogDescription>
            {recording
              ? `Update the name, folder, tags, notes, and transcript snippets for "${recording.name}".`
              : "Update the recording metadata."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            className="grid gap-4"
            id="recording-metadata-form"
            onSubmit={form.handleSubmit((values) => {
              void onSubmit({
                folder: values.folder.trim(),
                name: values.name.trim(),
                notes: values.notes.trim() || null,
                tags: tagsFromText(values.tags),
                transcriptSnippets: transcriptSnippetsFromText(values.transcriptSnippets),
              })
                .then(() => onOpenChange(false))
                .catch(() => undefined);
            })}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="folder"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Folder</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="tags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="transcriptSnippets"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Transcript snippets</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} />
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
          <Button disabled={saveDisabled} form="recording-metadata-form" type="submit">
            <Save className="size-4" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const emptyDraft: RecordingMetadataDraft = {
  folder: "",
  name: "",
  notes: "",
  tags: "",
  transcriptSnippets: "",
};

function draftFromRecording(recording: RecordingSummary): RecordingMetadataDraft {
  return {
    folder: recording.folder,
    name: recording.name,
    notes: recording.notes ?? "",
    tags: tagsToText(recording.tags),
    transcriptSnippets: transcriptSnippetsToText(recording.transcriptSnippets),
  };
}
