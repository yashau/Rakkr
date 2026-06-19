import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RecordingBulkOrganizer } from "@/components/recording-bulk-organizer";
import { RecordingCard } from "@/components/recording-card";
import { RecordingFacetPanel } from "@/components/recording-facet-panel";
import { RecordingStartPanel } from "@/components/recording-start-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [notice, setNotice] = useState<{ detail: string; title: string }>();
  const currentUserQuery = useQuery({
    queryFn: api.currentUser,
    queryKey: ["auth", "me"],
    staleTime: 30_000,
  });
  const recordingsQuery = useQuery({
    queryFn: () => api.recordings(recordingFilters),
    queryKey: ["recordings", recordingFilters],
  });
  const recordingFacetsQuery = useQuery({
    queryFn: api.recordingFacets,
    queryKey: ["recording-facets"],
  });
  const recordingJobsQuery = useQuery({
    queryFn: api.recordingJobs,
    queryKey: ["recording-jobs"],
    refetchInterval: 3000,
  });
  const healthEventsQuery = useQuery({
    queryFn: () => api.healthEvents({ limit: 500 }),
    queryKey: ["health-events", "recordings"],
    refetchInterval: 5000,
  });
  const uploadQueueQuery = useQuery({
    queryFn: api.uploadQueue,
    queryKey: ["upload-queue"],
    refetchInterval: 5000,
  });
  const uploadPoliciesQuery = useQuery({
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

  const currentUserPermissions = currentUserQuery.data?.data.permissions ?? [];
  const canControlRecordings = currentUserPermissions.includes("recording:control");
  const canCreateRecordings = currentUserPermissions.includes("recording:create");
  const canDeleteRecordings = currentUserPermissions.includes("recording:delete");
  const canDownloadRecordings = currentUserPermissions.includes("recording:download");
  const canEditRecordings = currentUserPermissions.includes("recording:edit");
  const canPlaybackRecordings = currentUserPermissions.includes("recording:playback");
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
    if (
      window.confirm(`Delete ${selectedTerminalRecordingIds.length} selected terminal recordings?`)
    ) {
      bulkDeleteRecordingMutation.mutate(selectedTerminalRecordingIds);
    }
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

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Recordings</h2>
      </div>

      {canCreateRecordings ? <RecordingStartPanel onNotice={setNotice} /> : null}

      {notice ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <div className="font-medium">{notice.title}</div>
          <div className="text-emerald-700">{notice.detail}</div>
        </section>
      ) : null}

      {audioPreview ? (
        <section className="rounded-lg border border-border bg-panel px-4 py-3 shadow-sm">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{audioPreview.fileName}</div>
              <div className="text-xs text-muted-foreground">
                Session {audioPreview.sessionId} started {formatDateTime(audioPreview.startedAt)}
              </div>
            </div>
            <Button
              aria-label="Close playback"
              onClick={closeAudioPreview}
              size="icon"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>
          <audio className="w-full" controls src={audioPreview.objectUrl}>
            <track kind="captions" />
          </audio>
        </section>
      ) : null}

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
            <select
              className={selectClassName}
              id="recording-status-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  status: event.target.value as RecordingFilterDraft["status"],
                }))
              }
              value={filterDraft.status}
            >
              <option value="">Any status</option>
              {recordingStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-sort-filter">Sort</Label>
            <select
              className={selectClassName}
              id="recording-sort-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  sortBy: event.target.value as RecordingFilterDraft["sortBy"],
                }))
              }
              value={filterDraft.sortBy}
            >
              <option value="">Default order</option>
              {recordingSortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-sort-order-filter">Order</Label>
            <select
              className={selectClassName}
              id="recording-sort-order-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  sortOrder: event.target.value as RecordingSortOrder,
                }))
              }
              value={filterDraft.sortOrder}
            >
              {recordingSortOrders.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
                setFilterDraft((current) => ({ ...current, recordedToDate: event.target.value }))
              }
              type="date"
              value={filterDraft.recordedToDate}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="recording-health-filter">Health</Label>
            <select
              className={selectClassName}
              id="recording-health-filter"
              onChange={(event) =>
                setFilterDraft((current) => ({
                  ...current,
                  healthStatus: event.target.value as RecordingFilterDraft["healthStatus"],
                }))
              }
              value={filterDraft.healthStatus}
            >
              <option value="">Any health</option>
              {healthStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
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
          </div>
        ) : null}
        {recordingMeta ? (
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="grid gap-1.5">
              <Label htmlFor="recording-page-size">Page size</Label>
              <select
                className={selectClassName}
                id="recording-page-size"
                onChange={(event) => changePageSize(Number(event.target.value))}
                value={pageSize}
              >
                {recordingPageSizes.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
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
      </form>

      {(canEditRecordings || canDeleteRecordings || canControlRecordings) &&
      recordings.length > 0 ? (
        <RecordingBulkOrganizer
          allVisibleSelected={allVisibleSelected}
          canDelete={canDeleteRecordings}
          canEdit={canEditRecordings}
          canUpload={canControlRecordings}
          deleteDisabled={bulkDeleteRecordingMutation.isPending}
          deleteEligibleCount={selectedTerminalRecordingIds.length}
          disabled={
            bulkMetadataMutation.isPending ||
            bulkDeleteRecordingMutation.isPending ||
            bulkEnqueueUploadMutation.isPending
          }
          onApply={(input) => bulkMetadataMutation.mutate(input)}
          onClear={() => setSelectedRecordingIds([])}
          onDeleteSelected={deleteSelectedRecordings}
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
        <section className="rounded-lg border border-border bg-panel px-4 py-8 text-center text-sm text-muted-foreground">
          No recordings match the current filters.
        </section>
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
            editPending={updateMetadataMutation.isPending}
            jobs={jobs}
            key={recording.id}
            onDelete={() => {
              if (window.confirm(`Delete recording "${recording.name}"?`)) {
                deleteRecordingMutation.mutate(recording.id);
              }
            }}
            onDownload={() => downloadMutation.mutate(recording.id)}
            onPlayback={() => playbackMutation.mutate(recording.id)}
            onQueueUpload={(uploadPolicyId) =>
              enqueueUploadMutation.mutate({ recordingId: recording.id, uploadPolicyId })
            }
            onRetryUpload={(itemId) => retryUploadMutation.mutate(itemId)}
            onSelectedChange={
              canEditRecordings || canDeleteRecordings || canControlRecordings
                ? (selected) => setRecordingSelected(recording.id, selected)
                : undefined
            }
            onStop={() => stopMutation.mutate(recording.id)}
            onUpdate={(input) =>
              updateMetadataMutation.mutateAsync({
                input,
                recordingId: recording.id,
              })
            }
            playbackPending={playbackMutation.isPending}
            recording={recording}
            retryUploadPending={retryUploadMutation.isPending}
            selected={selectedRecordingIdSet.has(recording.id)}
            stopPending={stopMutation.isPending}
            uploadItems={uploadItemsByRecording.get(recording.id) ?? []}
            uploadPolicies={uploadPolicies}
            uploadPending={enqueueUploadMutation.isPending}
          />
        );
      })}
    </div>
  );
}
