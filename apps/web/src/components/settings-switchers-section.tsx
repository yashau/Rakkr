import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  switcherModelCatalog,
  type SwitcherCreate,
  type SwitcherMode,
  type SwitcherModel,
  type SwitcherStatus,
  type SwitcherUpdate,
} from "@rakkr/shared";
import { Network, Pencil, Plus, PlugZap, PlusCircle, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Field, Toggle } from "@/components/settings-fields";
import { HintButton } from "@/components/hint-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { toneBadgeClass } from "@/lib/status-colors";
import { switcherModeTone, switcherTestSummary } from "@/lib/switcher-page-helpers";
import { cn } from "@/lib/utils";

const switcherModes: SwitcherMode[] = ["disabled", "observe", "enforce"];
const switcherModeLabels: Record<SwitcherMode, string> = {
  disabled: "Disabled",
  enforce: "Enforce (drives hardware)",
  observe: "Observe (dry-run)",
};

interface SwitcherDraft {
  displayName: string;
  enabled: boolean;
  host: string;
  mode: SwitcherMode;
  model: SwitcherModel;
  password: string;
  port: string;
  username: string;
}

type EditorState =
  | { mode: "create"; switcher?: undefined }
  | { mode: "edit"; switcher: SwitcherStatus };

export function SettingsSwitchersSection({
  canManage,
  canMap,
  canRead,
}: {
  canManage: boolean;
  canMap: boolean;
  canRead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>();
  const [mappingTarget, setMappingTarget] = useState<SwitcherStatus>();
  const [pendingDelete, setPendingDelete] = useState<SwitcherStatus>();
  const switchersQuery = useQuery({
    enabled: canRead,
    queryFn: api.switchers,
    queryKey: ["switchers"],
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSwitcher(id),
    onError: () =>
      toast.error("Delete failed", { description: "The switcher could not be deleted." }),
    onSuccess: () => {
      toast.success("Switcher deleted");
      void queryClient.invalidateQueries({ queryKey: ["switchers"] });
      setPendingDelete(undefined);
    },
  });
  const testMutation = useMutation({
    mutationFn: (id: string) => api.testSwitcher(id),
    onError: () =>
      toast.error("Test failed", { description: "The switcher could not be reached." }),
    onSuccess: ({ data }) => {
      if (data.ok) {
        toast.success("Switcher reachable", { description: switcherTestSummary(data) });
      } else {
        toast.error("Switcher unreachable", { description: switcherTestSummary(data) });
      }
    },
  });

  const switchers = switchersQuery.data?.data ?? [];
  const enforcingCount = switchers.filter((switcher) => switcher.mode === "enforce").length;
  const columns = switcherColumns({
    canManage,
    canMap,
    onDelete: setPendingDelete,
    onEdit: (switcher) => setEditor({ mode: "edit", switcher }),
    onMap: setMappingTarget,
    onTest: (id) => testMutation.mutate(id),
    testingId: testMutation.isPending ? testMutation.variables : undefined,
  });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Audio Matrix Switchers</h2>
          <p className="text-sm text-muted-foreground">
            Route room audio to listener desks on an external matrix switcher. When a room's
            scheduled meeting is live and assigned to a user, the room's input is auto-routed to
            that user's output. New switchers start in observe mode and never drive hardware until
            promoted to enforce.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn(toneBadgeClass("neutral"), "w-fit")} variant="outline">
            {enforcingCount} enforcing
          </Badge>
          <HintButton
            disabled={!canManage}
            hint={canManage ? "Add a switcher" : "Requires switcher manage"}
            onClick={() => setEditor({ mode: "create" })}
            variant="outline"
          >
            <PlusCircle className="size-4" />
            New
          </HintButton>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-2 shadow-sm">
        <DataTable
          columns={columns}
          data={switchers}
          emptyMessage="No audio matrix switchers are configured."
          getRowId={(switcher) => switcher.id}
          isLoading={switchersQuery.isPending}
        />
      </section>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setEditor(undefined))}
        open={Boolean(editor)}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "edit" ? "Edit Switcher" : "New Switcher"}</DialogTitle>
            <DialogDescription>
              Connection settings are stored on the controller (never in a .env). The
              control-channel password, if the model needs one, is encrypted at rest.
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <SwitcherEditor
              canManage={canManage}
              onSaved={() => setEditor(undefined)}
              switcher={editor.mode === "edit" ? editor.switcher : undefined}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setMappingTarget(undefined))}
        open={Boolean(mappingTarget)}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Channel Mappings{mappingTarget ? ` — ${mappingTarget.displayName}` : ""}
            </DialogTitle>
            <DialogDescription>
              Assign a room to each switcher input and a user to each switcher output. Only outputs
              mapped to a user are ever driven; everything else stays under manual control.
            </DialogDescription>
          </DialogHeader>
          {mappingTarget ? (
            <SwitcherMappingsEditor
              canMap={canMap}
              onSaved={() => setMappingTarget(undefined)}
              switcher={mappingTarget}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => (open ? undefined : setPendingDelete(undefined))}
        open={Boolean(pendingDelete)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete switcher?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.displayName}" and its channel mappings will be removed. The device itself is left untouched.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SwitcherEditor({
  canManage,
  onSaved,
  switcher,
}: {
  canManage: boolean;
  onSaved: () => void;
  switcher?: SwitcherStatus;
}) {
  const queryClient = useQueryClient();
  const isCreate = !switcher;
  const [draft, setDraft] = useState<SwitcherDraft>(() => initialDraft(switcher));
  const mutation = useMutation({
    mutationFn: () =>
      switcher
        ? api.updateSwitcher(switcher.id, buildUpdate(draft))
        : api.createSwitcher(buildCreate(draft)),
    onError: () => toast.error("Save failed", { description: "The switcher could not be saved." }),
    onSuccess: () => {
      toast.success("Switcher saved");
      void queryClient.invalidateQueries({ queryKey: ["switchers"] });
      onSaved();
    },
  });

  useEffect(() => {
    setDraft(initialDraft(switcher));
  }, [switcher]);

  const catalog = switcherModelCatalog[draft.model];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <Input
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, displayName: event.target.value }))
            }
            placeholder="Hansard Matrix"
            value={draft.displayName}
          />
        </Field>
        <Field label="Model">
          <Select
            disabled={!canManage || !isCreate}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, model: value as SwitcherModel }))
            }
            value={draft.model}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(switcherModelCatalog).map((model) => (
                <SelectItem key={model.model} value={model.model}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Host / IP">
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
            placeholder="172.22.195.101"
            value={draft.host}
          />
        </Field>
        <Field label={`Port (default ${catalog.defaultPort})`}>
          <Input
            disabled={!canManage}
            onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value }))}
            placeholder={String(catalog.defaultPort)}
            type="number"
            value={draft.port}
          />
        </Field>
        <Field label="Mode">
          <Select
            disabled={!canManage}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, mode: value as SwitcherMode }))
            }
            value={draft.mode}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {switcherModes.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {switcherModeLabels[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Toggle
          checked={draft.enabled}
          disabled={!canManage}
          label="Enabled"
          onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
        />
        <Field label="Username (optional)">
          <Input
            autoComplete="off"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, username: event.target.value }))
            }
            value={draft.username}
          />
        </Field>
        <Field label="Password (optional)">
          <Input
            autoComplete="new-password"
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({ ...current, password: event.target.value }))
            }
            placeholder={switcher?.hasPassword ? "•••••••• (unchanged)" : ""}
            type="password"
            value={draft.password}
          />
        </Field>
      </div>

      <p className="text-xs text-muted-foreground">
        {catalog.inputs} inputs × {catalog.outputs} outputs.{" "}
        {catalog.requiresLogin
          ? "This model authenticates the control channel with the username/password."
          : "This model's control channel is open; credentials are optional."}
      </p>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Button
          disabled={
            mutation.isPending ||
            !canManage ||
            draft.displayName.trim().length === 0 ||
            draft.host.trim().length === 0
          }
          onClick={() => mutation.mutate()}
        >
          <Save className="size-4" />
          Save
        </Button>
      </div>
    </div>
  );
}

function SwitcherMappingsEditor({
  canMap,
  onSaved,
  switcher,
}: {
  canMap: boolean;
  onSaved: () => void;
  switcher: SwitcherStatus;
}) {
  const queryClient = useQueryClient();
  const mappingsQuery = useQuery({
    queryFn: () => api.switcherMappings(switcher.id),
    queryKey: ["switcher-mappings", switcher.id],
  });
  const optionsQuery = useQuery({
    queryFn: api.switcherMappingOptions,
    queryKey: ["switcher-mapping-options"],
  });
  const [inputs, setInputs] = useState<Array<{ input: number; roomId: string }>>([]);
  const [outputs, setOutputs] = useState<Array<{ output: number; userId: string }>>([]);
  const mutation = useMutation({
    mutationFn: () =>
      api.updateSwitcherMappings(switcher.id, {
        inputs: inputs.filter((entry) => entry.roomId),
        outputs: outputs.filter((entry) => entry.userId),
      }),
    onError: (error) =>
      toast.error("Save failed", {
        description: error instanceof Error ? error.message : "The mappings could not be saved.",
      }),
    onSuccess: () => {
      toast.success("Mappings saved");
      void queryClient.invalidateQueries({ queryKey: ["switcher-mappings", switcher.id] });
      onSaved();
    },
  });

  useEffect(() => {
    const data = mappingsQuery.data?.data;

    if (data) {
      setInputs(data.inputs.map((entry) => ({ input: entry.input, roomId: entry.roomId })));
      setOutputs(data.outputs.map((entry) => ({ output: entry.output, userId: entry.userId })));
    }
  }, [mappingsQuery.data]);

  const options = optionsQuery.data?.data;

  if (mappingsQuery.isPending || optionsQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading mappings…</p>;
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <MappingColumn
          addLabel="Add input"
          canMap={canMap}
          emptyLabel="No inputs mapped."
          max={switcher.inputs}
          onAdd={() =>
            setInputs((current) => [
              ...current,
              { input: nextChannel(current, "input", switcher.inputs), roomId: "" },
            ])
          }
          rows={inputs.map((entry, index) => ({
            channel: entry.input,
            key: index,
            onChannel: (value) =>
              setInputs((current) =>
                current.map((row, i) => (i === index ? { ...row, input: value } : row)),
              ),
            onRemove: () => setInputs((current) => current.filter((_, i) => i !== index)),
            onSelect: (value) =>
              setInputs((current) =>
                current.map((row, i) => (i === index ? { ...row, roomId: value } : row)),
              ),
            selectId: entry.roomId,
          }))}
          selectOptions={(options?.rooms ?? []).map((room) => ({
            id: room.id,
            label: room.site ? `${room.name} (${room.site})` : room.name,
          }))}
          selectPlaceholder="Select room"
          title="Room inputs"
        />
        <MappingColumn
          addLabel="Add output"
          canMap={canMap}
          emptyLabel="No outputs mapped."
          max={switcher.outputs}
          onAdd={() =>
            setOutputs((current) => [
              ...current,
              { output: nextChannel(current, "output", switcher.outputs), userId: "" },
            ])
          }
          rows={outputs.map((entry, index) => ({
            channel: entry.output,
            key: index,
            onChannel: (value) =>
              setOutputs((current) =>
                current.map((row, i) => (i === index ? { ...row, output: value } : row)),
              ),
            onRemove: () => setOutputs((current) => current.filter((_, i) => i !== index)),
            onSelect: (value) =>
              setOutputs((current) =>
                current.map((row, i) => (i === index ? { ...row, userId: value } : row)),
              ),
            selectId: entry.userId,
          }))}
          selectOptions={(options?.users ?? []).map((user) => ({
            id: user.id,
            label: user.email ? `${user.name} (${user.email})` : user.name,
          }))}
          selectPlaceholder="Select user"
          title="User outputs"
        />
      </div>

      {mutation.isError ? <p className="text-sm text-destructive">Save failed.</p> : null}

      <div className="flex justify-end">
        <Button disabled={mutation.isPending || !canMap} onClick={() => mutation.mutate()}>
          <Save className="size-4" />
          Save mappings
        </Button>
      </div>
    </div>
  );
}

interface MappingRow {
  channel: number;
  key: number;
  onChannel: (value: number) => void;
  onRemove: () => void;
  onSelect: (value: string) => void;
  selectId: string;
}

function MappingColumn({
  addLabel,
  canMap,
  emptyLabel,
  max,
  onAdd,
  rows,
  selectOptions,
  selectPlaceholder,
  title,
}: {
  addLabel: string;
  canMap: boolean;
  emptyLabel: string;
  max: number;
  onAdd: () => void;
  rows: MappingRow[];
  selectOptions: Array<{ id: string; label: string }>;
  selectPlaceholder: string;
  title: string;
}) {
  return (
    <div className="grid content-start gap-2 rounded-lg border border-border bg-panel p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button disabled={!canMap} onClick={onAdd} size="sm" type="button" variant="outline">
          <Plus className="size-4" />
          {addLabel}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        rows.map((row) => (
          <div className="flex items-center gap-2" key={row.key}>
            <Input
              aria-label="Channel"
              className="w-16"
              disabled={!canMap}
              max={max}
              min={1}
              onChange={(event) => row.onChannel(Number(event.target.value))}
              type="number"
              value={row.channel}
            />
            <Select disabled={!canMap} onValueChange={row.onSelect} value={row.selectId}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={selectPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {selectOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={!canMap}
              onClick={row.onRemove}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
              <span className="sr-only">Remove</span>
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function nextChannel(
  rows: Array<{ input: number } | { output: number }>,
  key: "input" | "output",
  max: number,
): number {
  const used = new Set(
    rows.map((row) =>
      key === "input" ? (row as { input: number }).input : (row as { output: number }).output,
    ),
  );

  for (let channel = 1; channel <= max; channel += 1) {
    if (!used.has(channel)) {
      return channel;
    }
  }

  return max;
}

function initialDraft(switcher?: SwitcherStatus): SwitcherDraft {
  return {
    displayName: switcher?.displayName ?? "",
    enabled: switcher?.enabled ?? false,
    host: switcher?.host ?? "",
    mode: switcher?.mode ?? "observe",
    model: switcher?.model ?? "avpro-ac-max",
    password: "",
    port: switcher ? String(switcher.port) : "",
    username: switcher?.username ?? "",
  };
}

function buildCreate(draft: SwitcherDraft): SwitcherCreate {
  return {
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    host: draft.host.trim(),
    mode: draft.mode,
    model: draft.model,
    ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    ...(draft.password ? { password: draft.password } : {}),
  };
}

function buildUpdate(draft: SwitcherDraft): SwitcherUpdate {
  return {
    displayName: draft.displayName.trim(),
    enabled: draft.enabled,
    host: draft.host.trim(),
    mode: draft.mode,
    username: draft.username.trim() ? draft.username.trim() : null,
    ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
    ...(draft.password ? { password: draft.password } : {}),
  };
}

function switcherColumns({
  canManage,
  canMap,
  onDelete,
  onEdit,
  onMap,
  onTest,
  testingId,
}: {
  canManage: boolean;
  canMap: boolean;
  onDelete: (switcher: SwitcherStatus) => void;
  onEdit: (switcher: SwitcherStatus) => void;
  onMap: (switcher: SwitcherStatus) => void;
  onTest: (id: string) => void;
  testingId: string | undefined;
}): ColumnDef<SwitcherStatus>[] {
  return [
    {
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium text-foreground">{row.original.displayName}</div>
          <div className="font-mono text-xs text-muted-foreground">
            {row.original.host}:{row.original.port}
          </div>
        </div>
      ),
      header: "Name",
      id: "name",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {switcherModelCatalog[row.original.model]?.label ?? row.original.model}
        </span>
      ),
      header: "Model",
      id: "model",
    },
    {
      cell: ({ row }) => (
        <Badge className={toneBadgeClass(switcherModeTone(row.original.mode))} variant="outline">
          {row.original.mode}
        </Badge>
      ),
      header: "Mode",
      id: "mode",
    },
    {
      cell: ({ row }) => (
        <span className="text-sm">{row.original.enabled ? "Enabled" : "Disabled"}</span>
      ),
      header: "State",
      id: "state",
    },
    {
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button
            disabled={testingId === row.original.id || !canManage}
            onClick={() => onTest(row.original.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlugZap className="size-4" />
            {testingId === row.original.id ? "Testing…" : "Test"}
          </Button>
          <Button
            disabled={!canMap}
            onClick={() => onMap(row.original)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Network className="size-4" />
            Map
          </Button>
          <Button
            disabled={!canManage}
            onClick={() => onEdit(row.original)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Pencil className="size-4" />
            Edit
          </Button>
          <Button
            disabled={!canManage}
            onClick={() => onDelete(row.original)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      ),
      header: () => <span className="sr-only">Actions</span>,
      id: "actions",
      meta: { cellClassName: "text-right", headClassName: "text-right" },
    },
  ];
}
