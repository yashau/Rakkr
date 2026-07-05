import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { RecorderNode } from "@rakkr/shared";
import { CheckCircle2, Copy, PlusCircle, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";

import { NodeChannelRoomEditor } from "@/components/channel-room-assignment-editor";
import {
  NodeAudioDefaultsEditor,
  NodeIdentityEditor,
  NodeInterfaceEditor,
} from "@/components/node-inventory-editors";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type NodeBootstrapTokenResult, type NodeEnrollmentInput } from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { buildAgentInstallCommand } from "@/lib/node-page-helpers";

interface EnrollmentForm {
  alias: string;
  building: string;
  floor: string;
  hostname: string;
  notes: string;
  room: string;
  site: string;
  tags: string;
}

const emptyEnrollmentForm: EnrollmentForm = {
  alias: "",
  building: "",
  floor: "",
  hostname: "",
  notes: "",
  room: "",
  site: "",
  tags: "",
};

interface EnrolledNode {
  alias: string;
  id: string;
  room: string;
  site: string;
}

function defaultControllerUrl() {
  // The browser origin is the best default for the address the node reaches the
  // controller at (web + API share an origin behind the reverse proxy). The
  // operator can edit it when the node connects via a different hostname.
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Enroll follows the documented low-touch day-0 flow (see
 * `docs/guides/node-onboarding.md`): the operator enters only node identity, the
 * dialog enrolls the node and mints a single-use bootstrap token, then hands
 * back the copy-paste installer one-liner. The agent reports its real audio
 * hardware on first contact — no hand-typed interfaces, channels, or sample
 * rates. The `["nodes"]` query is invalidated so the table shows the new node.
 */
export function EnrollNodeDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"details" | "provision">("details");
  const [enrolled, setEnrolled] = useState<EnrolledNode | undefined>();
  const [bootstrap, setBootstrap] = useState<NodeBootstrapTokenResult | undefined>();
  const [controllerUrl, setControllerUrl] = useState(defaultControllerUrl);
  const form = useForm<EnrollmentForm>({ defaultValues: emptyEnrollmentForm });

  const provisionMutation = useMutation({
    mutationFn: async (values: EnrollmentForm) => {
      const { data: enrollment } = await api.enrollNode(enrollmentInput(values));
      const { data: token } = await api.mintNodeBootstrapToken(enrollment.node.id);
      return { node: enrollment.node, token };
    },
    onError: () =>
      toast.error("Enroll failed", {
        description: "The recorder node could not be enrolled.",
      }),
    onSuccess: ({ node, token }) => {
      setEnrolled({
        alias: node.alias,
        id: node.id,
        room: node.location.room,
        site: node.location.site,
      });
      setBootstrap(token);
      setStep("provision");
      toast.success("Node enrolled", {
        description: "Copy the install command onto the new host.",
      });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  function resetFlow() {
    form.reset(emptyEnrollmentForm);
    setStep("details");
    setEnrolled(undefined);
    setBootstrap(undefined);
    setControllerUrl(defaultControllerUrl());
    provisionMutation.reset();
  }

  const installCommand =
    enrolled && bootstrap
      ? buildAgentInstallCommand({
          bootstrapToken: bootstrap.token,
          controllerUrl,
          nodeId: enrolled.id,
          room: enrolled.room,
          site: enrolled.site,
        })
      : "";

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          resetFlow();
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button type="button">
            <PlusCircle className="size-4" />
            Enroll Node
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enroll Recorder Node</DialogTitle>
          <DialogDescription>
            {step === "details"
              ? "Enter the node's identity. The agent reports its audio hardware on first contact — no manual interface setup."
              : "Run this on the new Linux host to bring the node online."}
          </DialogDescription>
        </DialogHeader>

        {step === "details" ? (
          <Form {...form}>
            <form
              className="grid gap-4"
              id="enroll-node-form"
              onSubmit={form.handleSubmit((values) => provisionMutation.mutate(values))}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <TextField control={form.control} label="Alias" name="alias" required />
                <TextField control={form.control} label="Hostname" name="hostname" required />
                <TextField control={form.control} label="Site" name="site" required />
                <TextField control={form.control} label="Room" name="room" required />
              </div>

              <Accordion>
                <AccordionItem className="border-none" value="optional">
                  <AccordionTrigger className="py-2">Optional details</AccordionTrigger>
                  <AccordionContent className="grid gap-3 md:grid-cols-2">
                    <TextField control={form.control} label="Building" name="building" />
                    <TextField control={form.control} label="Floor" name="floor" />
                    <TextField
                      control={form.control}
                      label="Tags"
                      name="tags"
                      placeholder="voice, room-a"
                    />
                    <FormField
                      control={form.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem className="md:col-span-2">
                          <FormLabel>Notes</FormLabel>
                          <FormControl>
                            <Textarea {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              {provisionMutation.isError ? (
                <p className="text-sm text-destructive">Node enrollment failed.</p>
              ) : null}
            </form>
          </Form>
        ) : (
          <div className="grid gap-4">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>{enrolled?.alias} enrolled</AlertTitle>
              <AlertDescription>
                The installer downloads the latest recorder agent, registers it with this single-use
                token, and reports the node&apos;s audio hardware automatically.
              </AlertDescription>
            </Alert>

            <div className="grid gap-2">
              <Label htmlFor="enroll-controller-url">Controller URL</Label>
              <Input
                id="enroll-controller-url"
                onChange={(event) => setControllerUrl(event.target.value)}
                placeholder="https://controller.example:8787"
                value={controllerUrl}
              />
              <p className="text-xs text-muted-foreground">
                The address the node reaches the controller at. Edit it if the node connects via a
                different hostname.
              </p>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Install command</Label>
                <Button
                  onClick={() => copyToClipboard(installCommand, "Install command copied")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {installCommand}
              </pre>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="enroll-bootstrap-token">Bootstrap token</Label>
                <Button
                  onClick={() => copyToClipboard(bootstrap?.token ?? "", "Token copied")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
              <Input
                className="font-mono text-xs"
                id="enroll-bootstrap-token"
                readOnly
                value={bootstrap?.token ?? ""}
              />
              <p className="text-xs text-muted-foreground">
                Single-use and shown once
                {bootstrap ? ` — expires ${formatDateTime(bootstrap.expiresAt)}` : ""}.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "details" ? (
            <>
              <Button onClick={() => setOpen(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={provisionMutation.isPending} form="enroll-node-form" type="submit">
                <PlusCircle className="size-4" />
                {provisionMutation.isPending ? "Enrolling…" : "Enroll & get install command"}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={resetFlow} type="button" variant="outline">
                Enroll another
              </Button>
              <Button onClick={() => setOpen(false)} type="button">
                Done
              </Button>
            </>
          )}
        </DialogFooter>
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
export function NodeConfigureDialog({
  canManage,
  node,
}: {
  canManage: boolean;
  node: RecorderNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button size="sm" type="button" variant="outline">
            <Settings2 className="size-4" />
            Configure
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {node.alias}</DialogTitle>
          <DialogDescription>
            Edit node identity, audio defaults, and audio interfaces.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <NodeIdentityEditor canManage={canManage} node={node} />
          <NodeChannelRoomEditor canManage={canManage} node={node} />
          <NodeAudioDefaultsEditor canManage={canManage} node={node} />
          {node.interfaces.map((audioInterface) => (
            <NodeInterfaceEditor
              audioInterface={audioInterface}
              canManage={canManage}
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

async function copyToClipboard(value: string, message: string) {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error("Copy failed", { description: "Copy the text manually." });
  }
}

function TextField({
  control,
  label,
  name,
  placeholder,
  required,
}: {
  control: ReturnType<typeof useForm<EnrollmentForm>>["control"];
  label: string;
  name: keyof EnrollmentForm;
  placeholder?: string;
  required?: boolean;
}): ReactNode {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...field} placeholder={placeholder} required={required} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function enrollmentInput(form: EnrollmentForm): NodeEnrollmentInput {
  return {
    // The agent reports its real version on first heartbeat; a placeholder is
    // fine until then.
    agentVersion: "unknown",
    alias: form.alias.trim(),
    hostname: form.hostname.trim(),
    // Interfaces reconcile from the agent's first-contact inventory report.
    interfaces: [],
    ipAddresses: [],
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
