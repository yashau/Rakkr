import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { RecorderNode } from "@rakkr/shared";
import { PlusCircle, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";

import {
  NodeAudioDefaultsEditor,
  NodeIdentityEditor,
  NodeInterfaceEditor,
} from "@/components/node-inventory-editors";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type NodeEnrollmentInput, type NodeEnrollmentResult } from "@/lib/api";

interface EnrollmentForm {
  agentVersion: string;
  alias: string;
  backend: NodeEnrollmentInput["interfaces"][number]["backend"];
  building: string;
  channelCount: string;
  floor: string;
  hardwarePath: string;
  hostname: string;
  interfaceAlias: string;
  ipAddresses: string;
  notes: string;
  room: string;
  sampleRates: string;
  serialNumber: string;
  site: string;
  systemName: string;
  tags: string;
}

const emptyEnrollmentForm: EnrollmentForm = {
  agentVersion: "0.1.0",
  alias: "",
  backend: "unknown",
  building: "",
  channelCount: "0",
  floor: "",
  hardwarePath: "",
  hostname: "",
  interfaceAlias: "",
  ipAddresses: "",
  notes: "",
  room: "",
  sampleRates: "",
  serialNumber: "",
  site: "",
  systemName: "",
  tags: "",
};

/**
 * Enrollment is relocated from the inline page form into a shadcn Dialog. The
 * mutation continues to invalidate the `["nodes"]` query so the data table picks
 * up the new node, and the one-time token is surfaced inside the dialog so the
 * operator can copy it before closing.
 */
export function EnrollNodeDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState<NodeEnrollmentResult | undefined>();
  const form = useForm<EnrollmentForm>({ defaultValues: emptyEnrollmentForm });
  const enrollMutation = useMutation({
    mutationFn: api.enrollNode,
    onError: () =>
      toast.error("Enroll failed", {
        description: "The recorder node could not be enrolled.",
      }),
    onSuccess: ({ data }) => {
      setCredential(data);
      form.reset(emptyEnrollmentForm);
      toast.success("Node enrolled", {
        description: "Copy the one-time token before closing this dialog.",
      });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          setCredential(undefined);
          form.reset(emptyEnrollmentForm);
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <PlusCircle className="size-4" />
          Enroll Node
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enroll Recorder Node</DialogTitle>
          <DialogDescription>Create a persisted node and one-time token.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="grid gap-4"
            onSubmit={form.handleSubmit((values) => enrollMutation.mutate(enrollmentInput(values)))}
          >
            <div className="grid gap-3 md:grid-cols-3">
              <TextField control={form.control} label="Alias" name="alias" required />
              <TextField control={form.control} label="Hostname" name="hostname" required />
              <TextField
                control={form.control}
                label="Agent Version"
                name="agentVersion"
                required
              />
              <TextField control={form.control} label="Site" name="site" required />
              <TextField control={form.control} label="Building" name="building" />
              <TextField control={form.control} label="Floor" name="floor" />
              <TextField control={form.control} label="Room" name="room" required />
              <TextField
                control={form.control}
                label="IP Addresses"
                name="ipAddresses"
                placeholder="10.0.0.25, 10.0.0.26"
              />
              <TextField
                control={form.control}
                label="Interface"
                name="interfaceAlias"
                placeholder="USB Audio"
              />
              <FormField
                control={form.control}
                name="backend"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Backend</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="h-10">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="unknown">unknown</SelectItem>
                        <SelectItem value="alsa">alsa</SelectItem>
                        <SelectItem value="jack">jack</SelectItem>
                        <SelectItem value="pipewire">pipewire</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <TextField
                control={form.control}
                label="Channels"
                min={0}
                name="channelCount"
                type="number"
              />
              <TextField
                control={form.control}
                label="System Name"
                name="systemName"
                placeholder="Behringer X32 Rack USB"
              />
              <TextField
                control={form.control}
                label="Hardware Path"
                name="hardwarePath"
                placeholder="/proc/asound/card1/pcm0c"
              />
              <TextField control={form.control} label="Serial Number" name="serialNumber" />
              <TextField
                control={form.control}
                label="Sample Rates"
                name="sampleRates"
                placeholder="48000, 44100"
              />
              <TextField
                control={form.control}
                label="Tags"
                name="tags"
                placeholder="voice, room-a"
              />
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {credential ? (
              <FormItem>
                <FormLabel>One-Time Node Token</FormLabel>
                <Textarea readOnly value={credential.credential.token} />
              </FormItem>
            ) : null}
            {enrollMutation.isError ? (
              <p className="text-sm text-destructive">Node enrollment failed.</p>
            ) : null}

            <DialogFooter>
              <Button onClick={() => setOpen(false)} type="button" variant="outline">
                Close
              </Button>
              <Button disabled={enrollMutation.isPending} type="submit">
                <PlusCircle className="size-4" />
                Enroll
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The heavy node identity / audio-defaults / interface editors are kept intact
 * and relocated into a single configuration dialog. Each editor still owns its
 * own save mutation and `["nodes"]` invalidation, so the table refreshes after
 * a save without extra wiring here.
 */
export function NodeConfigureDialog({ node }: { node: RecorderNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          <Settings2 className="size-4" />
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {node.alias}</DialogTitle>
          <DialogDescription>
            Edit node identity, audio defaults, and audio interfaces.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <NodeIdentityEditor canManage node={node} />
          <NodeAudioDefaultsEditor canManage node={node} />
          {node.interfaces.map((audioInterface) => (
            <NodeInterfaceEditor
              audioInterface={audioInterface}
              canManage
              key={audioInterface.id}
              node={node}
            />
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} type="button" variant="outline">
            <Save className="size-4" />
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  control,
  label,
  min,
  name,
  placeholder,
  required,
  type,
}: {
  control: ReturnType<typeof useForm<EnrollmentForm>>["control"];
  label: string;
  min?: number;
  name: keyof EnrollmentForm;
  placeholder?: string;
  required?: boolean;
  type?: "number" | "text";
}): ReactNode {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              min={min}
              placeholder={placeholder}
              required={required}
              type={type ?? "text"}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function enrollmentInput(form: EnrollmentForm): NodeEnrollmentInput {
  const channelCount = Number(form.channelCount);
  const systemName = form.systemName.trim();
  const interfaceAlias = form.interfaceAlias.trim();
  const hasInterface = systemName || interfaceAlias || channelCount > 0;

  return {
    agentVersion: form.agentVersion.trim(),
    alias: form.alias.trim(),
    hostname: form.hostname.trim(),
    interfaces: hasInterface
      ? [
          {
            alias: interfaceAlias || systemName || "Audio Interface",
            backend: form.backend,
            channelCount: Number.isFinite(channelCount) ? Math.max(0, channelCount) : 0,
            channels: [],
            hardwarePath: form.hardwarePath.trim() || undefined,
            sampleRates: parseNumbers(form.sampleRates),
            serialNumber: form.serialNumber.trim() || undefined,
            systemName: systemName || interfaceAlias || "Unknown Audio Interface",
          },
        ]
      : [],
    ipAddresses: parseList(form.ipAddresses),
    location: {
      building: form.building.trim() || undefined,
      floor: form.floor.trim() || undefined,
      room: form.room.trim(),
      site: form.site.trim(),
    },
    notes: form.notes.trim() || undefined,
    tags: parseList(form.tags),
  };
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumbers(value: string) {
  return parseList(value)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
}
