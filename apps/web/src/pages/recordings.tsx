import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RecordingBulkOrganizer } from "@/components/recording-bulk-organizer";
import { RecordingCacheStateFilter } from "@/components/recording-cache-state-filter";
import { RecordingCard } from "@/components/recording-card";
import { RecordingFacetPanel } from "@/components/recording-facet-panel";
import { RecordingPlaybackDock } from "@/components/recording-playback-dock";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { RecordingUploadQueueSummary } from "@/components/recording-upload-queue-summary";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  type RecordingFilters,
  type RecordingMetadataUpdate,
  type RecordingSortOrder,
} from "@/lib/api";
import { formatDateTime } from "@/lib/dates";
import {
  clearPlaybackPreview,
  defaultRecordingPageSize,
  downloadBlob,
  emptyRecordingFilterDraft,
  filtersFromDraft,
  groupHealthEventsByRecording,
  groupUploadItemsByRecording,
  isCachedRecording,
  healthStatuses,
  isTerminalRecording,
  playbackPreviewFromSession,
  recordingPagePermissions,
  recordingFilterChips,
  recordingFilterDraftKeys,
  replacePlaybackPreview,
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

export function RecordingsPage() {
  const queryClient = useQueryClient();
  const audioPreviewRef = useRef<RecordingPlaybackPreview | undefined>(undefined);
  const [audioPreview, setAudioPreview] = useState<RecordingPlaybackPreview>();
  const [filterDraft, setFilterDraft] = useState<RecordingFilterDraft>(emptyRecordingFilterDraft);
  const [pageSize, setPageSize] = useState(defaultRecordingPageSize);
  const [recordingFilters, setRecordingFilters] = useState<RecordingFilters>({
    limit: defaultRecordingPageSize,
    offset: 0,
  });
  const [selectedRecordingIds, setSelectedRecordingIds] = useState<string[]>([]);
  const setNotice = (next: { detail: string; title: string }) =>
    toast(next.title, { description: next.detail });
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const pagePermissions = recordingPagePermissions(currentUserQuery.data?.data);
  const recordingsQuery = useQuery({
    enabled: pagePermissions.canReadRecordings,
    queryFn: () => api.recordings(recordingFilters),
    queryKey: ["recordings", recordingFilters],
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
    queryFn: () => api.nodes(),
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["health-events"] });
      queryClient.invalidateQueries({ queryKey: ["recording-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
  const playbackMutation = useMutation({
    mutationFn: async (recordingId: string) => {
      const playback = await api.startPlayback(recordingId);
      const stream = await api.recordingStream(recordingId);

      return {
        playback: playback.data,
        stream,
      };
    },
    onError: () =>
      setNotice({
        detail: "The selected recording could not be opened for playback.",
        title: "Playback unavailable",
      }),
    onSuccess: (response) => {
      const url = URL.createObjectURL(response.stream.blob);
      const preview = playbackPreviewFromSession(response.playback, response.stream, url);

      setAudioPreview((current) => {
        const next = replacePlaybackPreview(current, preview);

        audioPreviewRef.current = next;

        return next;
      });
      setNotice({
        detail: `${response.playback.sessionId} started at ${formatDateTime(response.playback.startedAt)}`,
        title: "Playback ready",
      });
    },
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
      queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
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
      queryClient.invalidateQueries({ queryKey: ["audit-events"] });
      queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
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
      queryClient.invalidateQueries({ queryKey: ["upload-queue"] });
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
  const activeFilterChips = recordingFilterChips(recordingFilters);
  const activeFilterCount = activeFilterChips.length;
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
  const paginationLimit = recordingMeta?.limit ?? pageSize;
  const paginationOffset = recordingMeta?.offset ?? 0;
  const currentPage = Math.floor(paginationOffset / paginationLimit) + 1;
  const totalPages = Math.max(
    1,
    Math.ceil((recordingMeta?.total ?? recordings.length) / paginationLimit),
  );

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
    const nextDraft = { ...filterDraft, ...patch };

    setFilterDraft(nextDraft);
    setRecordingFilters({ ...filtersFromDraft(nextDraft), limit: pageSize, offset: 0 });
  };

  const clearActiveFilter = (key: RecordingFilterKey) => {
    const nextFilters = { ...recordingFilters };

    delete nextFilters[key];
    if (key === "sortBy") {
      delete nextFilters.sortOrder;
    }
    nextFilters.limit = pageSize;
    nextFilters.offset = 0;
    setRecordingFilters(nextFilters);
    setFilterDraft((current) => ({
      ...current,
      [recordingFilterDraftKeys[key]]: "",
      ...(key === "sortBy" ? { sortOrder: "desc" as const } : {}),
    }));
  };

  const applyRecordingFilters = (nextDraft: RecordingFilterDraft) => {
    setRecordingFilters({ ...filtersFromDraft(nextDraft), limit: pageSize, offset: 0 });
  };

  const changePageSize = (nextPageSize: number) => {
    setPageSize(nextPageSize);
    setRecordingFilters((current) => ({
      ...current,
      limit: nextPageSize,
      offset: 0,
    }));
  };

  const changePage = (offset: number) => {
    setRecordingFilters((current) => ({
      ...current,
      limit: pageSize,
      offset,
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
        <h2 className="text-base font-semibold">Recordings</h2>
      </div>

      {canCreateRecordings ? (
        <RecordingStartPanel
          canReadNodes={pagePermissions.canReadNodes}
          canReadSettings={pagePermissions.canReadSettings}
          onNotice={setNotice}
        />
      ) : null}

      {audioPreview ? (
        <RecordingPlaybackDock onClose={closeAudioPreview} preview={audioPreview} />
      ) : null}

      {!pagePermissions.canReadRecordings ? (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>Recording library</AlertTitle>
          <AlertDescription>Recording library details are unavailable.</AlertDescription>
        </Alert>
      ) : (
        <>
          <form
            className="grid gap-3 rounded-lg border border-border bg-panel p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              applyRecordingFilters(filterDraft);
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Library filters</h3>
                <p className="text-xs text-muted-foreground">
                  {recordingMeta
                    ? `${recordingMeta.returned} of ${recordingMeta.total} results`
                    : `${recordings.length} result${recordings.length === 1 ? "" : "s"}`}
                  {activeFilterCount > 0 ? `, ${activeFilterCount} filter active` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit">
                  <Search className="size-4" />
                  Search
                </Button>
                <Button
                  onClick={() => {
                    setFilterDraft(emptyRecordingFilterDraft);
                    setRecordingFilters({ limit: pageSize, offset: 0 });
                  }}
                  type="button"
                  variant="outline"
                >
                  <RotateCcw className="size-4" />
                  Clear
                </Button>
                <Button
                  disabled={exportMutation.isPending}
                  onClick={() => exportMutation.mutate()}
                  type="button"
                  variant="outline"
                >
                  <Download className="size-4" />
                  Export CSV
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="grid gap-1.5 md:col-span-2">
                <Label htmlFor="recording-search">Search</Label>
                <Input
                  id="recording-search"
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, search: event.target.value }))
                  }
                  placeholder="Name, folder, tag, ID, node, schedule, profile, upload policy, track group"
                  value={filterDraft.search}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-folder-filter">Folder</Label>
                <Input
                  id="recording-folder-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, folder: event.target.value }))
                  }
                  value={filterDraft.folder}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-tag-filter">Tag</Label>
                <Input
                  id="recording-tag-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, tag: event.target.value }))
                  }
                  value={filterDraft.tag}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-node-filter">Node</Label>
                <Input
                  id="recording-node-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, nodeId: event.target.value }))
                  }
                  value={filterDraft.nodeId}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-schedule-filter">Schedule</Label>
                <Input
                  id="recording-schedule-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({ ...current, scheduleId: event.target.value }))
                  }
                  value={filterDraft.scheduleId}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-track-group-filter">Track Group</Label>
                <Input
                  id="recording-track-group-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      trackGroupId: event.target.value,
                    }))
                  }
                  value={filterDraft.trackGroupId}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-profile-filter">Profile</Label>
                <Input
                  id="recording-profile-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordingProfileId: event.target.value,
                    }))
                  }
                  value={filterDraft.recordingProfileId}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-upload-policy-filter">Upload Policy</Label>
                <Input
                  id="recording-upload-policy-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      uploadPolicyId: event.target.value,
                    }))
                  }
                  value={filterDraft.uploadPolicyId}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-status-filter">Status</Label>
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      status: (value === "__all__" ? "" : value) as RecordingFilterDraft["status"],
                    }))
                  }
                  value={filterDraft.status || "__all__"}
                >
                  <SelectTrigger className={selectClassName} id="recording-status-filter">
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
              </div>
              <RecordingCacheStateFilter
                onChange={(cacheState) => setFilterDraft((current) => ({ ...current, cacheState }))}
                value={filterDraft.cacheState}
              />
              <div className="grid gap-1.5">
                <Label htmlFor="recording-sort-filter">Sort</Label>
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      sortBy: (value === "__all__" ? "" : value) as RecordingFilterDraft["sortBy"],
                    }))
                  }
                  value={filterDraft.sortBy || "__all__"}
                >
                  <SelectTrigger className={selectClassName} id="recording-sort-filter">
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
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-sort-order-filter">Order</Label>
                <Select
                  onValueChange={(value) =>
                    setFilterDraft((current) => ({
                      ...current,
                      sortOrder: value as RecordingSortOrder,
                    }))
                  }
                  value={filterDraft.sortOrder}
                >
                  <SelectTrigger className={selectClassName} id="recording-sort-order-filter">
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
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-from-filter">From</Label>
                <Input
                  id="recording-from-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordedFromDate: event.target.value,
                    }))
                  }
                  type="date"
                  value={filterDraft.recordedFromDate}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-to-filter">To</Label>
                <Input
                  id="recording-to-filter"
                  onChange={(event) =>
                    setFilterDraft((current) => ({
                      ...current,
                      recordedToDate: event.target.value,
                    }))
                  }
                  type="date"
                  value={filterDraft.recordedToDate}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="recording-health-filter">Health</Label>
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
                  <SelectTrigger className={selectClassName} id="recording-health-filter">
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
              </div>
            </div>
            {activeFilterChips.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {activeFilterChips.map((filter) => (
                  <Badge
                    className="max-w-full gap-1 overflow-hidden bg-background pr-1"
                    key={filter.key}
                    variant="outline"
                  >
                    <span className="shrink-0 text-muted-foreground">{filter.label}</span>
                    <span className="truncate font-mono">{filter.value}</span>
                    <button
                      aria-label={`Clear ${filter.label} filter`}
                      className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => clearActiveFilter(filter.key)}
                      type="button"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <Button
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setRecordingFilters({ limit: pageSize, offset: 0 });
                    setFilterDraft(emptyRecordingFilterDraft);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Clear all
                </Button>
              </div>
            ) : null}
            {recordingMeta ? (
              <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="recording-page-size">Page size</Label>
                  <Select
                    onValueChange={(value) => changePageSize(Number(value))}
                    value={String(pageSize)}
                  >
                    <SelectTrigger className={selectClassName} id="recording-page-size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {recordingPageSizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    disabled={!recordingMeta.hasPreviousPage}
                    onClick={() => changePage(Math.max(0, paginationOffset - paginationLimit))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <ChevronLeft className="size-4" />
                    Previous
                  </Button>
                  <Button
                    disabled={!recordingMeta.hasNextPage}
                    onClick={() => changePage(paginationOffset + paginationLimit)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
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
          </form>

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
                onPlayback={() => playbackMutation.mutate(recording.id)}
                onQueueUpload={(uploadPolicyId) =>
                  enqueueUploadMutation.mutate({ recordingId: recording.id, uploadPolicyId })
                }
                onRetryUpload={(itemId) => retryUploadMutation.mutate(itemId)}
                onSelectedChange={(selected) => setRecordingSelected(recording.id, selected)}
                onStop={() => stopMutation.mutate(recording.id)}
                onUpdate={(input) =>
                  updateMetadataMutation.mutateAsync({
                    input,
                    recordingId: recording.id,
                  })
                }
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
        </>
      )}
    </div>
  );
}
