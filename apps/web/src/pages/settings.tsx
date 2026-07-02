import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, ShieldAlert } from "lucide-react";
import { type WeekStartDay } from "@rakkr/shared";

import { toast } from "sonner";

import { HintButton } from "@/components/hint-button";
import { SettingsChannelMapsSection } from "@/components/settings-channel-maps-section";
import { Field } from "@/components/settings-fields";
import { SettingsRecordingProfilesSection } from "@/components/settings-recording-profiles-section";
import { SettingsRetentionPoliciesSection } from "@/components/settings-retention-policies-section";
import { SettingsUploadDestinationsSection } from "@/components/settings-upload-destinations-section";
import { SettingsUploadPoliciesSection } from "@/components/settings-upload-policies-section";
import { SettingsWatchdogPoliciesSection } from "@/components/settings-watchdog-policies-section";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UploadRunnerPanel } from "@/components/upload-runner-panel";
import { api } from "@/lib/api";
import { nodePickerFilters } from "@/lib/node-page-helpers";
import { settingsPagePermissions } from "@/lib/settings-page-helpers";

const weekStartDays: WeekStartDay[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function SettingsPage() {
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
  });
  const pagePermissions = settingsPagePermissions(currentUserQuery.data?.data);
  const canReadNodes = pagePermissions.canReadNodes;
  const canReadSettings = pagePermissions.canReadSettings;
  const canManageSettings = pagePermissions.canManageSettings;
  const controllerSettingsQuery = useQuery({
    enabled: canReadSettings,
    queryFn: api.controllerSettings,
    queryKey: ["controller-settings"],
  });
  const nodesQuery = useQuery({
    enabled: canReadSettings && canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
  });

  if (currentUserQuery.isPending) {
    return <SettingsAccessState description="Checking current permissions." title="Loading" />;
  }

  if (!canReadSettings) {
    return (
      <SettingsAccessState
        description="Your account does not have settings read permission."
        title="Settings Access Denied"
      />
    );
  }

  const nodes = nodesQuery.data?.data ?? [];

  return (
    <div className="grid gap-6">
      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-lg font-semibold">Controller</h2>
          <p className="text-sm text-muted-foreground">
            Identity for this controller instance, shown in the console header.
          </p>
        </div>
      </section>

      <ControllerSettingsCard
        canManage={canManageSettings}
        controllerName={controllerSettingsQuery.data?.data.controllerName ?? ""}
        loading={controllerSettingsQuery.isPending}
        weekStartsOn={controllerSettingsQuery.data?.data.weekStartsOn ?? "monday"}
      />

      <SettingsRecordingProfilesSection canManage={canManageSettings} canRead={canReadSettings} />

      <SettingsWatchdogPoliciesSection
        canManage={canManageSettings}
        canRead={canReadSettings}
        canReadNodes={canReadNodes}
        nodes={nodes}
      />

      <SettingsUploadDestinationsSection canManage={canManageSettings} canRead={canReadSettings} />

      <SettingsUploadPoliciesSection canManage={canManageSettings} canRead={canReadSettings} />

      <SettingsRetentionPoliciesSection canManage={canManageSettings} canRead={canReadSettings} />

      <UploadRunnerPanel />

      <SettingsChannelMapsSection
        canManage={canManageSettings}
        canRead={canReadSettings}
        canReadNodes={canReadNodes}
        nodes={nodes}
      />
    </div>
  );
}

function ControllerSettingsCard({
  canManage,
  controllerName,
  loading,
  weekStartsOn,
}: {
  canManage: boolean;
  controllerName: string;
  loading: boolean;
  weekStartsOn: WeekStartDay;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(controllerName);
  const [weekStartDraft, setWeekStartDraft] = useState<WeekStartDay>(weekStartsOn);
  const mutation = useMutation({
    mutationFn: () =>
      api.updateControllerSettings({
        controllerName: draft.trim(),
        weekStartsOn: weekStartDraft,
      }),
    onError: () =>
      toast.error("Save failed", {
        description: "The controller settings could not be saved.",
      }),
    onSuccess: ({ data }) => {
      setDraft(data.controllerName);
      setWeekStartDraft(data.weekStartsOn);
      void queryClient.invalidateQueries({ queryKey: ["controller-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    },
  });

  useEffect(() => {
    setDraft(controllerName);
  }, [controllerName]);

  useEffect(() => {
    setWeekStartDraft(weekStartsOn);
  }, [weekStartsOn]);

  const trimmed = draft.trim();
  const unchanged = trimmed === controllerName && weekStartDraft === weekStartsOn;

  return (
    <Card className="rounded-lg p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="grid gap-3 md:flex md:max-w-2xl md:flex-1 md:flex-row">
          <div className="md:max-w-sm md:flex-1">
            <Field label="Controller name">
              <Input
                disabled={!canManage || loading}
                maxLength={160}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Rakkr Controller"
                value={draft}
              />
            </Field>
          </div>
          <div className="md:max-w-48 md:flex-1">
            <Field label="Week starts on">
              <Select
                disabled={!canManage || loading}
                onValueChange={(value) => setWeekStartDraft(value as WeekStartDay)}
                value={weekStartDraft}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {weekStartDays.map((day) => (
                    <SelectItem key={day} value={day}>
                      {capitalize(day)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>
        <HintButton
          disabled={
            mutation.isPending || !canManage || loading || unchanged || trimmed.length === 0
          }
          hint={canManage ? "Save controller settings" : "Requires settings manage"}
          onClick={() => mutation.mutate()}
        >
          <Save className="size-4" />
          Save
        </HintButton>
      </div>
    </Card>
  );
}

function SettingsAccessState({ description, title }: { description: string; title: string }) {
  return (
    <Card className="rounded-lg p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <ShieldAlert className="size-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </Card>
  );
}

function capitalize(value: string) {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
