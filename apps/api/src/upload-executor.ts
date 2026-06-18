import type { UploadProvider, UploadQueueItem } from "@rakkr/shared";
import { createUploadProviderStore, type UploadProviderStore } from "./upload-providers.js";
import {
  failUploadQueueItem,
  listDueUploadQueueItems,
  startUploadQueueItem,
  succeedUploadQueueItem,
} from "./upload-queue.js";

interface UploadExecutorOptions {
  limit?: number;
  now?: Date;
  providerStore?: UploadProviderStore;
}

interface ProviderUploadResult {
  ok: boolean;
  reason?: string;
}

export interface UploadQueueRunItem {
  itemId: string;
  provider: UploadProvider;
  reason?: string;
  recordingId: string;
  status: UploadQueueItem["status"];
}

export interface UploadQueueRunSummary {
  attempted: number;
  deferred: number;
  failed: number;
  items: UploadQueueRunItem[];
  succeeded: number;
}

export async function runUploadQueueOnce(
  options: UploadExecutorOptions = {},
): Promise<UploadQueueRunSummary> {
  const limit = Math.max(0, options.limit ?? 10);
  const providerStore = options.providerStore ?? createUploadProviderStore();
  const dueItems = (await listDueUploadQueueItems(options.now)).slice(0, limit);
  const items: UploadQueueRunItem[] = [];

  for (const dueItem of dueItems) {
    const item = await startUploadQueueItem(dueItem.id);

    if (!item) {
      continue;
    }

    const provider = await providerStore.findStatus(item.provider);
    const providerResult =
      provider.status === "ready"
        ? await runProviderUpload(item)
        : { ok: false, reason: provider.reason ?? `provider_${provider.status}` };
    const next = providerResult.ok
      ? await succeedUploadQueueItem(item.id)
      : await failUploadQueueItem(item.id, providerResult.reason ?? "upload_failed");

    if (next) {
      items.push({
        itemId: next.id,
        provider: next.provider,
        reason: next.lastError,
        recordingId: next.recordingId,
        status: next.status,
      });
    }
  }

  return {
    attempted: items.length,
    deferred: items.filter((item) => item.status === "retrying").length,
    failed: items.filter((item) => item.status === "failed").length,
    items,
    succeeded: items.filter((item) => item.status === "succeeded").length,
  };
}

async function runProviderUpload(item: UploadQueueItem): Promise<ProviderUploadResult> {
  if (!item.cachePath) {
    return { ok: false, reason: "cache_path_missing" };
  }

  if (item.provider === "stub") {
    return { ok: true };
  }

  return { ok: false, reason: "provider_not_implemented" };
}
