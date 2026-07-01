import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FilterField, FilterToolbar } from "@/components/filter-toolbar";
import { RecordingBulkOrganizer } from "@/components/recording-bulk-organizer";
import { RecordingCacheStateFilter } from "@/components/recording-cache-state-filter";
import { RecordingCard } from "@/components/recording-card";
import { RecordingFacetPanel } from "@/components/recording-facet-panel";
import { RecordingMetadataDialog } from "@/components/recording-metadata-dialog";
import { RecordingPlaybackDock } from "@/components/recording-playback-dock";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { RecordingUploadQueueSummary } from "@/components/recording-upload-queue-summary";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  type RecordingBulkMetadataUpdate,
  type RecordingMetadataUpdate,
  type RecordingSortOrder,
} from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import { nodePickerFilters } from "@/lib/node-page-helpers";
import {
  auditedUploadActionQueryKeys,
  clearPlaybackPreview,
  defaultRecordingPageSize,
  downloadBlob,
  emptyRecordingFilterDraft,
  filtersFromDraft,
  availableRecordingRenditions,
  groupHealthEventsByRecording,
  groupUploadItemsByRecording,
  isCachedRecording,
  healthStatuses,
  isTerminalRecording,
  recordingPagePermissions,
  recordingFilterChips,
  recordingFilterDraftKeys,
  type RecordingFilterDraft,
  type RecordingFilterKey,
  type RecordingPlaybackPreview,
  recordingPageSizes,
  recordingSortOptions,
  recordingSortOrders,
  recordingStatuses,
  selectClassName,
  uploadQueueStatusSummary,
} from "@/lib/recording-page-helpers";
import { useRecordingPlaybackMutation } from "@/lib/recording-playback";
import { useServerPagination } from "@/lib/use-server-pagination";

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const audioPreviewRef = useRef<RecordingPlaybackPreview | undefined>(undefined);
  const [audioPreview, setAudioPreview] = useState<RecordingPlaybackPreview>();
  const [filterDraft, setFilterDraft] = useState<RecordingFilterDraft>(emptyRecordingFilterDraft);
  const recordingFilters = useMemo(() => filtersFromDraft(filterDraft), [filterDraft]);
  const [selectedRecordingIds, setSelectedRecordingIds] = useState<string[]>([]);
  const [editingRecordingId, setEditingRecordingId] = useState<string>();
  const [metadataDialogOpen, setMetadataDialogOpen] = useState(false);
  const setNotice = (next: { detail: string; title: string }) =>
    toast(next.title, { description: next.detail });
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const pagePermissions = recordingPagePermissions(currentUserQuery.data?.data);
  const pagination = useServerPagination(recordingFilters, {
    defaultPageSize: defaultRecordingPageSize,
    pageSizes: recordingPageSizes,
  });
  const recordingsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    placeholderData: keepPreviousData,
    queryFn: () => api.recordings(pagination.query),
    queryKey: ["recordings", pagination.query],
  });
  const recordingFacetsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    queryFn: api.recordingFacets,
    queryKey: ["recording-facets"],
  });
  const recordingJobsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    queryFn: () => api.recordingJobs(),
    queryKey: ["recording-jobs"],
    refetchInterval: 3000,
  });
  const healthEventsQuery = useQuery({
    enabled: pagePermissions.canReadHealth,
    queryFn: () => api.healthEvents({ limit: 500 }),
    queryKey: ["health-events", "recordings"],
    refetchInterval: 5000,
  });
  const uploadQueueQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    queryFn: () => api.uploadQueue(),
    queryKey: ["upload-queue"],
    refetchInterval: 5000,
  });
  const nodesQuery = useQuery({
    enabled: pagePermissions.canReadNodes,
    queryFn: () => api.nodes(nodePickerFilters()),
    queryKey: ["nodes"],
  });
  const recordingProfilesQuery = useQuery({
    enabled: pagePermissions.canReadSettings,
    queryFn: api.recordingProfiles,
    queryKey: ["recording-profiles"],
  });
  const schedulesQuery = useQuery({
    enabled: pagePermissions.canReadSchedules,
    queryFn: () => api.schedules(),
    queryKey: ["schedules"],
  });
  const uploadPoliciesQuery = useQuery({
    enabled: pagePermissions.canReadSettings,
    queryFn: api.uploadPolicies,
    queryKey: ["upload-policies"],
  });
  const stopMutation = useMutation({
    mutationFn: api.stopRecording,
    onError: () =>
      setNotice({
        detail: "The selected recording could not be stopped.",
        title: "Stop failed",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const playbackMutation = useRecordingPlaybackMutation({
    audioPreviewRef,
    setAudioPreview,
    setNotice,
  });
  const downloadMutation = useMutation({
    mutationFn: async (recordingId: string) => {
      const ticket = await api.prepareRecordingDownload(recordingId);
      const file = await api.recordingFile(recordingId);

      return {
        file,
        ticket: ticket.data,
      };
    },
    onError: () =>
      setNotice({
        detail: "The selected recording could not be prepared for download.",
        title: "Download unavailable",
      }),
    onSuccess: (response) => {
      downloadBlob(response.file);
      setNotice({
        detail: `${response.ticket.fileName} prepared until ${formatDateTime(response.ticket.expiresAt)}`,
        title: "Download prepared",
      });
    },
  });
  const exportMutation = useMutation({
    mutationFn: () => api.exportRecordingManifest(recordingFilters),
    onError: () =>
      setNotice({
        detail: "The filtered recording manifest could not be exported.",
        title: "Export unavailable",
      }),
    onSuccess: (file) => {
      downloadBlob(file);
      setNotice({
        detail: `${file.fileName} was prepared from the current filters.`,
        title: "Manifest exported",
      });
    },
  });
  const selectedExportMutation = useMutation({
    mutationFn: (recordingIds: string[]) => api.exportSelectedRecordingManifest({ recordingIds }),
    onError: () =>
      setNotice({
        detail: "The selected recording manifest could not be exported.",
        title: "Export unavailable",
      }),
    onSuccess: (file, recordingIds) => {
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      downloadBlob(file);
      setNotice({
        detail: `${file.fileName} was prepared from ${recordingIds.length} selected recordings.`,
        title: "Selected manifest exported",
      });
    },
  });
  const updateMetadataMutation = useMutation({
    mutationFn: ({ input, recordingId }: { input: RecordingMetadataUpdate; recordingId: string }) =>
      api.updateRecordingMetadata(recordingId, input),
    onError: () =>
      setNotice({
        detail: "The selected recording metadata could not be saved.",
        title: "Update failed",
      }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["recording-facets"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      setNotice({
        detail: `${response.data.name} was saved.`,
        title: "Recording updated",
      });
    },
  });
  const bulkMetadataMutation = useMutation({
    mutationFn: (input: Omit<RecordingBulkMetadataUpdate, "recordingIds">) =>
      api.updateRecordingBulkMetadata({
        ...input,
        recordingIds: selectedRecordingIds,
      }),
    onError: () =>
      setNotice({
        detail: "The selected recordings could not be organized.",
        title: "Bulk update failed",
      }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-facets"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      setSelectedRecordingIds([]);
      setNotice({
        detail: `${response.meta.updatedCount} recordings were updated.`,
        title: "Recordings organized",
      });
    },
  });
  const deleteRecordingMutation = useMutation({
    mutationFn: api.deleteRecording,
    onError: () =>
      setNotice({
        detail: "The selected recording could not be deleted.",
        title: "Delete failed",
      }),
    onSuccess: (_response, recordingId) => {
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-facets"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
      setSelectedRecordingIds((current) =>
        current.filter((candidate) => candidate !== recordingId),
      );
      setNotice({
        detail: "The recording metadata and cached file were removed.",
        title: "Recording deleted",
      });
    },
  });
  const bulkDeleteRecordingMutation = useMutation({
    mutationFn: (recordingIds: string[]) => api.deleteRecordings({ recordingIds }),
    onError: () =>
      setNotice({
        detail: "The selected terminal recordings could not all be deleted.",
        title: "Bulk delete failed",
      }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-facets"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
      queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
      const deletedIds = new Set(response.data.map((recording) => recording.id));

      setSelectedRecordingIds((current) =>
        current.filter((candidate) => !deletedIds.has(candidate)),
      );
      setNotice({
        detail: `${response.meta.deletedCount} recordings were removed.`,
        title: "Recordings deleted",
      });
    },
  });
  const enqueueUploadMutation = useMutation({
    mutationFn: (input: { recordingId: string; uploadPolicyId?: string }) =>
      api.enqueueRecordingUpload(input.recordingId, { uploadPolicyId: input.uploadPolicyId }),
    onError: () =>
      setNotice({
        detail: "The selected cached recording could not be queued for upload.",
        title: "Upload queue unavailable",
      }),
    onSuccess: (response) => {
      for (const queryKey of auditedUploadActionQueryKeys) {
        queryClient.invalidateQueries({ queryKey });
      }
      setNotice({
        detail: `${response.data.provider} upload queue item ${response.data.status}.`,
        title: "Upload queued",
      });
    },
  });
  const bulkEnqueueUploadMutation = useMutation({
    mutationFn: (input: { recordingIds: string[]; uploadPolicyId?: string }) =>
      api.enqueueRecordingsUpload(input),
    onError: () =>
      setNotice({
        detail: "The selected cached recordings could not be queued for upload.",
        title: "Bulk upload queue unavailable",
      }),
    onSuccess: (response) => {
      for (const queryKey of auditedUploadActionQueryKeys) {
        queryClient.invalidateQueries({ queryKey });
      }
      setNotice({
        detail: `${response.meta.queuedCount} cached recordings were queued.`,
        title: "Uploads queued",
      });
    },
  });
  const retryUploadMutation = useMutation({
    mutationFn: api.retryUploadQueueItem,
    onError: () =>
      setNotice({
        detail: "The upload queue item could not be retried.",
        title: "Retry unavailable",
      }),
    onSuccess: (response) => {
      for (const queryKey of auditedUploadActionQueryKeys) {
        queryClient.invalidateQueries({ queryKey });
      }
      setNotice({
        detail: `${response.data.provider} retry scheduled for ${formatDateTime(response.data.nextAttemptAt)}.`,
        title: "Upload retry scheduled",
      });
    },
  });

  const canControlRecordings = pagePermissions.canControlRecordings;
  const canCreateRecordings = pagePermissions.canCreateRecordings;
  const canDeleteRecordings = pagePermissions.canDeleteRecordings;
  const canDownloadRecordings = pagePermissions.canDownloadRecordings;
  const canEditRecordings = pagePermissions.canEditRecordings;
  const canPlaybackRecordings = pagePermissions.canPlaybackRecordings;
  const recordings = recordingsQuery.data?.data ?? [];
  const recordingMeta = recordingsQuery.data?.meta;
  const facets = recordingFacetsQuery.data?.data;
  const topFolders = facets?.folders.slice(0, 8) ?? [];
  const topNodes = facets?.nodes.slice(0, 8) ?? [];
  const topRecordingProfiles = facets?.recordingProfiles.slice(0, 8) ?? [];
  const topTags = facets?.tags.slice(0, 12) ?? [];
  const topTrackGroups = facets?.trackGroups.slice(0, 8) ?? [];
  const topUploadPolicies = facets?.uploadPolicies.slice(0, 8) ?? [];
  const healthEventsByRecording = groupHealthEventsByRecording(healthEventsQuery.data?.data ?? []);
  const uploadItemsByRecording = groupUploadItemsByRecording(uploadQueueQuery.data?.data ?? []);
  const nodes = nodesQuery.data?.data ?? [];
  const recordingProfiles = recordingProfilesQuery.data?.data ?? [];
  const schedules = schedulesQuery.data?.data ?? [];
  const uploadPolicies = uploadPoliciesQuery.data?.data ?? [];
  // Free-text search is inline in the toolbar; the slide-out chips/count cover
  // the remaining filters.
  const advancedFilterChips = recordingFilterChips(recordingFilters).filter(
    (chip) => chip.key !== "search",
  );
  const selectedRecordingIdSet = new Set(selectedRecordingIds);
  const selectedRecordings = recordings.filter((recording) =>
    selectedRecordingIdSet.has(recording.id),
  );
  const selectedTerminalRecordingIds = selectedRecordings
    .filter((recording) => isTerminalRecording(recording))
    .map((recording) => recording.id);
  const selectedCachedRecordingIds = selectedRecordings
    .filter((recording) => isCachedRecording(recording))
    .map((recording) => recording.id);
  const visibleRecordingIds = recordings.map((recording) => recording.id);
  const uploadStatusCounts = uploadQueueStatusSummary(
    uploadQueueQuery.data?.data ?? [],
    visibleRecordingIds,
  );
  const allVisibleSelected =
    visibleRecordingIds.length > 0 &&
    visibleRecordingIds.every((recordingId) => selectedRecordingIdSet.has(recordingId));
  const editingRecording = recordings.find((recording) => recording.id === editingRecordingId);

  useEffect(() => {
    audioPreviewRef.current = audioPreview;
  }, [audioPreview]);

  useEffect(() => () => clearPlaybackPreview(audioPreviewRef.current), []);

  useEffect(() => {
    const visibleIds = new Set(visibleRecordingIds);

    setSelectedRecordingIds((current) => {
      const next = current.filter((recordingId) => visibleIds.has(recordingId));

      return next.length === current.length ? current : next;
    });
  }, [visibleRecordingIds]);

  const applyFacetFilter = (
    patch: Partial<
      Pick<
        RecordingFilterDraft,
        "folder" | "nodeId" | "recordingProfileId" | "tag" | "trackGroupId" | "uploadPolicyId"
      >
    >,
  ) => {
    setFilterDraft((current) => ({ ...current, ...patch }));
  };

  const clearActiveFilter = (key: RecordingFilterKey) => {
    setFilterDraft((current) => ({
      ...current,
      [recordingFilterDraftKeys[key]]: "",
      ...(key === "sortBy" ? { sortOrder: "desc" as const } : {}),
    }));
  };

  const selectVisibleRecordings = () => {
    setSelectedRecordingIds((current) => [...new Set([...current, ...visibleRecordingIds])]);
  };

  const setRecordingSelected = (recordingId: string, selected: boolean) => {
    setSelectedRecordingIds((current) =>
      selected
        ? [...new Set([...current, recordingId])]
        : current.filter((candidate) => candidate !== recordingId),
    );
  };
  const deleteSelectedRecordings = () => {
    bulkDeleteRecordingMutation.mutate(selectedTerminalRecordingIds);
  };
  const uploadSelectedRecordings = (uploadPolicyId?: string) => {
    bulkEnqueueUploadMutation.mutate({
      recordingIds: selectedCachedRecordingIds,
      uploadPolicyId,
    });
  };
  const closeAudioPreview = () => {
    setAudioPreview((current) => {
      const next = clearPlaybackPreview(current);

      audioPreviewRef.current = next;

      return next;
    });
  };

  if (currentUserQuery.isPending) {
    return <LoadingSkeleton label="Loading recordings" />;
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Recordings</h2>
          {pagePermissions.canReadRecordings ? (
            <p className="text-sm text-muted-foreground">
              {recordingMeta
                ? `${recordingMeta.returned} of ${recordingMeta.total} results`
                : `${recordings.length} result${recordings.length === 1 ? "" : "s"}`}
            </p>
          ) : null}
        </div>
      </div>

      {canCreateRecordings ? (
        <RecordingStartPanel
          canReadNodes={pagePermissions.canReadNodes}
          canReadSettings={pagePermissions.canReadSettings}
          onNotice={setNotice}
        />
      ) : null}

      {audioPreview ? (
        <RecordingPlaybackDock
          availableRenditions={availableRecordingRenditions(
            recordings.find((recording) => recording.id === audioPreview.recordingId),
          )}
          onClose={closeAudioPreview}
          onSelectRendition={(rendition) =>
            playbackMutation.mutate({ recordingId: audioPreview.recordingId, rendition })
          }
          preview={audioPreview}
        />
      ) : null}

      {!pagePermissions.canReadRecordings ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>Recording library</AlertTitle>
          <AlertDescription>Recording library details are unavailable.</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm">
            <FilterToolbar
              actions={
                <Button
                  disabled={exportMutation.isPending}
                  onClick={() => exportMutation.mutate()}
                  type="button"
                  variant="outline"
                >
                  <Download className="size-4" />
                  Export CSV
                </Button>
              }
              chips={advancedFilterChips}
              onClearAll={() => setFilterDraft(emptyRecordingFilterDraft)}
              onClearChip={(key) => clearActiveFilter(key as RecordingFilterKey)}
              onSearchChange={(value) =>
                setFilterDraft((current) => ({ ...current, search: value }))
              }
              search={filterDraft.search}
              searchPlaceholder="name, folder, tag, ID, node, schedule, profile, policy"
              sheetDescription="Filter the library by relationships, status, cache state, sort order, and recorded window."
              sheetTitle="Filter recordings"
            >
              <FilterField label="Status">
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      status: (value === "__all__" ? "" : value) as RecordingFilterDraft["status"],
                    }))
                  }
                  value={filterDraft.status || "__all__"}
                >
                  <SelectTrigger className={selectClassName}>
                    <SelectValue placeholder="Any status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Any status</SelectItem>
                    {recordingStatuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <RecordingCacheStateFilter
                onChange={(cacheState) => setFilterDraft((current) => ({ ...current, cacheState }))}
                value={filterDraft.cacheState}
              />
              <FilterField label="Health">
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      healthStatus: (value === "__all__"
                        ? ""
                        : value) as RecordingFilterDraft["healthStatus"],
                    }))
                  }
                  value={filterDraft.healthStatus || "__all__"}
                >
                  <SelectTrigger className={selectClassName}>
                    <SelectValue placeholder="Any health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Any health</SelectItem>
                    {healthStatuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label="Folder">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, folder: event.target.value }))
                  }
                  value={filterDraft.folder}
                />
              </FilterField>
              <FilterField label="Tag">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, tag: event.target.value }))
                  }
                  value={filterDraft.tag}
                />
              </FilterField>
              <FilterField label="Node">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, nodeId: event.target.value }))
                  }
                  value={filterDraft.nodeId}
                />
              </FilterField>
              <FilterField label="Schedule">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, scheduleId: event.target.value }))
                  }
                  value={filterDraft.scheduleId}
                />
              </FilterField>
              <FilterField label="Track Group">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      trackGroupId: event.target.value,
                    }))
                  }
                  value={filterDraft.trackGroupId}
                />
              </FilterField>
              <FilterField label="Profile">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordingProfileId: event.target.value,
                    }))
                  }
                  value={filterDraft.recordingProfileId}
                />
              </FilterField>
              <FilterField label="Upload Policy">
                <Input
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      uploadPolicyId: event.target.value,
                    }))
                  }
                  value={filterDraft.uploadPolicyId}
                />
              </FilterField>
              <FilterField label="Recorded From">
                <DatePicker
                  onChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordedFromDate: value,
                    }))
                  }
                  value={filterDraft.recordedFromDate}
                />
              </FilterField>
              <FilterField label="Recorded To">
                <DatePicker
                  onChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordedToDate: value,
                    }))
                  }
                  value={filterDraft.recordedToDate}
                />
              </FilterField>
              <FilterField label="Sort">
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      sortBy: (value === "__all__" ? "" : value) as RecordingFilterDraft["sortBy"],
                    }))
                  }
                  value={filterDraft.sortBy || "__all__"}
                >
                  <SelectTrigger className={selectClassName}>
                    <SelectValue placeholder="Default order" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Default order</SelectItem>
                    {recordingSortOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
              <FilterField label="Order">
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      sortOrder: value as RecordingSortOrder,
                    }))
                  }
                  value={filterDraft.sortOrder}
                >
                  <SelectTrigger className={selectClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recordingSortOrders.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
            </FilterToolbar>
            <RecordingFacetPanel
              folders={topFolders}
              nodes={topNodes}
              onFolder={(folder) => applyFacetFilter({ folder })}
              onNode={(nodeId) => applyFacetFilter({ nodeId })}
              onRecordingProfile={(recordingProfileId) => applyFacetFilter({ recordingProfileId })}
              onTag={(tag) => applyFacetFilter({ tag })}
              onTrackGroup={(trackGroupId) => applyFacetFilter({ trackGroupId })}
              onUploadPolicy={(uploadPolicyId) => applyFacetFilter({ uploadPolicyId })}
              recordingProfiles={topRecordingProfiles}
              tags={topTags}
              trackGroups={topTrackGroups}
              uploadPolicies={topUploadPolicies}
            />
            <RecordingUploadQueueSummary counts={uploadStatusCounts} />
          </div>

          {recordings.length > 0 ? (
            <RecordingBulkOrganizer
              allVisibleSelected={allVisibleSelected}
              canDelete={canDeleteRecordings}
              canEdit={canEditRecordings}
              canExport={pagePermissions.canReadRecordings}
              canUpload={canControlRecordings}
              deleteDisabled={bulkDeleteRecordingMutation.isPending}
              deleteEligibleCount={selectedTerminalRecordingIds.length}
              disabled={
                bulkMetadataMutation.isPending ||
                bulkDeleteRecordingMutation.isPending ||
                bulkEnqueueUploadMutation.isPending ||
                selectedExportMutation.isPending
              }
              exportDisabled={selectedExportMutation.isPending}
              onApply={(input) => bulkMetadataMutation.mutate(input)}
              onClear={() => setSelectedRecordingIds([])}
              onDeleteSelected={deleteSelectedRecordings}
              onExportSelected={() => selectedExportMutation.mutate(selectedRecordingIds)}
              onSelectVisible={selectVisibleRecordings}
              onUploadSelected={uploadSelectedRecordings}
              selectedCount={selectedRecordingIds.length}
              uploadDisabled={bulkEnqueueUploadMutation.isPending}
              uploadEligibleCount={selectedCachedRecordingIds.length}
              uploadPolicies={uploadPolicies}
              visibleCount={recordings.length}
            />
          ) : null}

          {!recordingsQuery.isPending && recordings.length === 0 ? (
            <Alert>
              <AlertDescription>No recordings match the current filters.</AlertDescription>
            </Alert>
          ) : null}

          {recordings.map((recording) => {
            const jobs =
              recordingJobsQuery.data?.data.filter((job) => job.recordingId === recording.id) ?? [];

            return (
              <RecordingCard
                canControl={canControlRecordings}
                canDelete={canDeleteRecordings}
                canDownload={canDownloadRecordings}
                deletePending={deleteRecordingMutation.isPending}
                downloadPending={downloadMutation.isPending}
                events={healthEventsByRecording.get(recording.id) ?? []}
                canEdit={canEditRecordings}
                canPlayback={canPlaybackRecordings}
                canReadHealth={pagePermissions.canReadHealth}
                editPending={updateMetadataMutation.isPending}
                jobs={jobs}
                key={recording.id}
                onDelete={() => deleteRecordingMutation.mutate(recording.id)}
                onDownload={() => downloadMutation.mutate(recording.id)}
                onPlayback={() => playbackMutation.mutate({ recordingId: recording.id })}
                onQueueUpload={(uploadPolicyId) =>
                  enqueueUploadMutation.mutate({ recordingId: recording.id, uploadPolicyId })
                }
                onEdit={() => {
                  setEditingRecordingId(recording.id);
                  setMetadataDialogOpen(true);
                }}
                onRetryUpload={(itemId) => retryUploadMutation.mutate(itemId)}
                onSelectedChange={(selected) => setRecordingSelected(recording.id, selected)}
                onStop={() => stopMutation.mutate(recording.id)}
                playbackPending={playbackMutation.isPending}
                recording={recording}
                relationshipReferences={{
                  nodes,
                  recordingProfiles,
                  schedules,
                  uploadPolicies,
                }}
                retryUploadPending={retryUploadMutation.isPending}
                selected={selectedRecordingIdSet.has(recording.id)}
                stopPending={stopMutation.isPending}
                uploadItems={uploadItemsByRecording.get(recording.id) ?? []}
                uploadPolicies={uploadPolicies}
                uploadPending={enqueueUploadMutation.isPending}
              />
            );
          })}

          <DataTablePagination
            meta={recordingMeta}
            onNext={pagination.nextPage}
            onPageSizeChange={pagination.setPageSize}
            onPrevious={pagination.previousPage}
            pageSize={pagination.pageSize}
            pageSizes={pagination.pageSizes}
          />

          {canEditRecordings ? (
            <RecordingMetadataDialog
              onOpenChange={(open) => {
                setMetadataDialogOpen(open);

                if (!open) {
                  setEditingRecordingId(undefined);
                }
              }}
              onSubmit={(input) =>
                updateMetadataMutation.mutateAsync({
                  input,
                  recordingId: editingRecordingId ?? "",
                })
              }
              open={metadataDialogOpen}
              recording={editingRecording}
              saving={updateMetadataMutation.isPending}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
