/**
 * ModelManager — download, cache, and manage on-device BitNet models.
 *
 * Features
 * ────────
 * • Auto-download from HuggingFace (`hf://owner/repo`) or any HTTPS URL
 * • Resumable downloads — survives network drops and app restarts
 * • Per-request progress callbacks
 * • Concurrent download guard — same modelId returns the in-flight promise
 * • Persistent JSON manifest (survives app restarts)
 * • Storage utilities: list, delete, total bytes used
 */

import type { DownloadOptions, ModelInfo, StorageInfo } from './types';
import {
  ModelDownloadError,
  ModelNotFoundError,
  InsufficientStorageError,
} from './errors';
import { resolveModelUrl } from './HuggingFaceResolver';
import { ModelCache } from './ModelCache';
import {
  createRNBFAdapter,
  DownloadCancelledError,
} from './DownloadAdapter';
import type { DownloadAdapter, DownloadTask } from './DownloadAdapter';

// 50 MB safety buffer on top of the model size
const FREE_SPACE_BUFFER_BYTES = 50 * 1024 * 1024;

// ─── Active download entry ────────────────────────────────────────────────────

interface ActiveDownload {
  task: DownloadTask | null;
  promise: Promise<ModelInfo>;
}

// ─── ModelManager ─────────────────────────────────────────────────────────────

export class ModelManager {
  private readonly adapter: DownloadAdapter;
  private readonly cache: ModelCache;
  private readonly activeDownloads = new Map<string, ActiveDownload>();

  /**
   * @param adapter  File-system + download backend. Defaults to the
   *                 react-native-blob-util adapter for production use.
   *                 Pass a mock in tests.
   */
  constructor(adapter?: DownloadAdapter) {
    this.adapter = adapter ?? createRNBFAdapter();
    this.cache = new ModelCache(this.adapter);
  }

  // Exposed for integration with BitNetClient
  getCache(): ModelCache {
    return this.cache;
  }

  // ── Download ─────────────────────────────────────────────────────────────────

  /**
   * Download a model and cache it locally.
   *
   * If the model is already fully downloaded the call returns immediately.
   * If a download for the same modelId is already in progress the existing
   * Promise is returned (no duplicate downloads).
   *
   * @example
   * await manager.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf', {
   *   onProgress: (p) => console.log(`${(p.progress * 100).toFixed(1)}%`),
   * });
   */
  /**
   * NOTE: this method is intentionally NOT async.
   *
   * `async` functions always return a NEW Promise wrapper, even when they
   * `return` an existing Promise. That means two concurrent callers would
   * each receive distinct Promise objects, defeating the deduplication guard.
   *
   * By keeping the function synchronous we guarantee that both callers receive
   * the exact same Promise reference when a download is already in flight.
   */
  downloadModel(
    modelId: string,
    opts: DownloadOptions = {}
  ): Promise<ModelInfo> {
    // ── Already in-flight? (synchronous check — no await before this) ────────
    const active = this.activeDownloads.get(modelId);
    if (active) return active.promise;

    // ── Register synchronously, then start the async work ────────────────────
    const entry: ActiveDownload = { task: null, promise: null as unknown as Promise<ModelInfo> };

    const promise = this._executeDownload(modelId, opts, entry).finally(() => {
      this.activeDownloads.delete(modelId);
    });

    entry.promise = promise;
    this.activeDownloads.set(modelId, entry); // ← registered before first await

    return promise; // same object returned to all concurrent callers
  }

  /** Thin wrapper that handles the cache-check + re-download logic after load. */
  private async _executeDownload(
    modelId: string,
    opts: DownloadOptions,
    entry: ActiveDownload
  ): Promise<ModelInfo> {
    await this.cache.ensureLoaded();

    // Already fully cached?
    const cached = this.cache.get(modelId);
    if (cached?.status === 'downloaded' && cached.localPath) {
      const stillOnDisk = await this.adapter.exists(cached.localPath);
      if (stillOnDisk) return cached;
      // File was deleted externally — fall through to re-download
    }

    return this._doDownload(modelId, opts, entry);
  }

  /**
   * Cancel an in-progress download.
   * The partial file is retained for the next resume attempt.
   */
  cancelDownload(modelId: string): void {
    this.activeDownloads.get(modelId)?.task?.cancel();
  }

  // ── Internal download logic ───────────────────────────────────────────────

  private async _doDownload(
    modelId: string,
    opts: DownloadOptions,
    entry: ActiveDownload
  ): Promise<ModelInfo> {
    // Mark as downloading in manifest right away
    await this.cache.set(modelId, {
      id: modelId,
      localPath: '',
      sizeBytes: -1,
      status: 'downloading',
    });

    try {
      // 1. Resolve the real download URL
      let resolved;
      try {
        resolved = await resolveModelUrl(modelId);
      } catch (e: unknown) {
        throw new ModelDownloadError(
          modelId,
          `Could not resolve URL: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // 2. Prepare paths
      await this.adapter.mkdir(this.cache.getModelsDir());
      const safeFilename = _sanitizeFilename(resolved.filename);
      const localPath = `${this.cache.getModelsDir()}/${safeFilename}`;
      const partialPath = `${localPath}.partial`;

      // 3. Disk space check (best-effort — -1 means "unknown, skip check")
      if (resolved.sizeBytes > 0) {
        const free = await this._getApproxFreeSpace();
        if (free !== -1 && free < resolved.sizeBytes + FREE_SPACE_BUFFER_BYTES) {
          throw new InsufficientStorageError(
            resolved.sizeBytes + FREE_SPACE_BUFFER_BYTES,
            free
          );
        }
      }

      // 4. Resume: how many bytes do we already have?
      let resumeFrom = 0;
      if (await this.adapter.exists(partialPath)) {
        try {
          const st = await this.adapter.stat(partialPath);
          resumeFrom = st.size;
        } catch {
          resumeFrom = 0;
        }
      }

      // 5. Build headers
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (resumeFrom > 0) {
        headers['Range'] = `bytes=${resumeFrom}-`;
      }

      const totalBytes = resolved.sizeBytes; // may be -1

      // 6. Start the download
      const { task, done } = this.adapter.downloadFile({
        url: resolved.downloadUrl,
        destPath: partialPath,
        headers,
        appendData: resumeFrom > 0,
        onProgress: (receivedNow, chunkTotal) => {
          const realReceived = resumeFrom + receivedNow;
          // When resuming, chunkTotal is only the remaining bytes
          const realTotal =
            totalBytes > 0 ? totalBytes : resumeFrom + chunkTotal;
          opts.onProgress?.({
            modelId,
            bytesReceived: realReceived,
            totalBytes: realTotal,
            progress: realTotal > 0 ? realReceived / realTotal : -1,
          });
        },
      });

      // Store the task so cancelDownload() can reach it
      entry.task = task;

      // 7. Await completion
      let result;
      try {
        result = await done;
      } catch (e: unknown) {
        if (e instanceof DownloadCancelledError) {
          // Keep the partial file for next resume; update status
          await this.cache.set(modelId, {
            id: modelId,
            localPath: '',
            sizeBytes: -1,
            status: 'error',
          });
          throw new ModelDownloadError(modelId, 'Download cancelled');
        }
        throw new ModelDownloadError(
          modelId,
          e instanceof Error ? e.message : String(e)
        );
      }

      if (result.status !== 200 && result.status !== 206) {
        throw new ModelDownloadError(modelId, `Unexpected HTTP status ${result.status}`);
      }

      // 8. Move partial → final path
      if (await this.adapter.exists(localPath)) {
        await this.adapter.unlink(localPath);
      }
      await this.adapter.move(partialPath, localPath);

      // 9. Stat the file for its real size
      const stat = await this.adapter.stat(localPath);

      const info: ModelInfo = {
        id: modelId,
        localPath,
        sizeBytes: stat.size,
        status: 'downloaded',
        downloadedAt: new Date().toISOString(),
      };

      await this.cache.set(modelId, info);
      return info;
    } catch (err: unknown) {
      // Ensure the manifest reflects the error state
      const existing = this.cache.get(modelId);
      if (existing?.status !== 'downloaded') {
        await this.cache.set(modelId, {
          ...(existing ?? { id: modelId, localPath: '', sizeBytes: -1 }),
          status: 'error',
        });
      }
      throw err;
    }
  }

  // ── Storage queries ───────────────────────────────────────────────────────

  /**
   * Whether a model is fully downloaded and its file exists on disk.
   */
  async isDownloaded(modelId: string): Promise<boolean> {
    await this.cache.ensureLoaded();
    const info = this.cache.get(modelId);
    if (!info || info.status !== 'downloaded' || !info.localPath) return false;
    return this.adapter.exists(info.localPath);
  }

  /**
   * Return the absolute local path for a downloaded model, or null.
   */
  getLocalPath(modelId: string): string | null {
    const info = this.cache.get(modelId);
    return info?.status === 'downloaded' && info.localPath ? info.localPath : null;
  }

  /**
   * Return all known models (any status) from the manifest.
   */
  async listModels(): Promise<ModelInfo[]> {
    await this.cache.ensureLoaded();
    return this.cache.getAll();
  }

  /**
   * Delete a model from disk and remove it from the manifest.
   * Throws {@link ModelNotFoundError} if the modelId is unknown.
   */
  async deleteModel(modelId: string): Promise<void> {
    await this.cache.ensureLoaded();
    const info = this.cache.get(modelId);
    if (!info) throw new ModelNotFoundError(modelId);

    // Delete the main file
    if (info.localPath && (await this.adapter.exists(info.localPath))) {
      await this.adapter.unlink(info.localPath);
    }

    // Delete any leftover partial file
    const partialPath = `${info.localPath}.partial`;
    if (partialPath && (await this.adapter.exists(partialPath))) {
      await this.adapter.unlink(partialPath);
    }

    await this.cache.remove(modelId);
  }

  /**
   * Summarise total disk usage across all cached models.
   */
  async getStorageInfo(): Promise<StorageInfo> {
    await this.cache.ensureLoaded();
    const models = this.cache.getAll();
    const totalBytes = models.reduce(
      (sum, m) => sum + (m.sizeBytes > 0 ? m.sizeBytes : 0),
      0
    );
    return { totalBytes, modelCount: models.length, models };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Best-effort free-space check.
   * react-native-blob-util does not expose a cross-platform free-space API,
   * so we return -1 (= skip the check) until a platform helper is wired in.
   */
  private async _getApproxFreeSpace(): Promise<number> {
    return -1;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Strip characters that are unsafe in a cross-platform filename. */
function _sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
