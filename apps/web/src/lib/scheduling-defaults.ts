import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

// The controller setting that holds the operator-chosen default for one policy
// type. Stored centrally (one id per type) so the "set as default" toggle is
// inherently single-select without a per-policy flag.
export type SchedulingDefaultField =
  | "defaultRecordingProfileId"
  | "defaultRetentionPolicyId"
  | "defaultUploadPolicyId"
  | "defaultWatchdogPolicyId";

export const controllerSettingsQueryKey = ["controller-settings"] as const;

/**
 * Read + toggle the default policy of a given type. Every settings section that
 * offers a "Set as default" control shares this: the current default id drives
 * the badge, and `setDefault` PATCHes the controller settings (passing `null`
 * clears it). All callers share the one `["controller-settings"]` query, so the
 * badge and the scheduling/ad-hoc prefill stay consistent.
 */
export function useSchedulingDefault(field: SchedulingDefaultField, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    enabled,
    queryFn: api.controllerSettings,
    queryKey: controllerSettingsQueryKey,
  });
  const mutation = useMutation({
    mutationFn: (id: string | null) => api.updateControllerSettings({ [field]: id }),
    onError: () =>
      toast.error("Update failed", { description: "The default could not be changed." }),
    onSuccess: ({ data }) => {
      toast.success(data[field] ? "Default set" : "Default cleared");
      void queryClient.invalidateQueries({ queryKey: controllerSettingsQueryKey });
    },
  });

  return {
    defaultId: query.data?.data[field] ?? null,
    isPending: mutation.isPending,
    // Toggle semantics: setting a policy that is already the default clears it.
    toggleDefault: (policyId: string) =>
      mutation.mutate(query.data?.data[field] === policyId ? null : policyId),
  };
}
