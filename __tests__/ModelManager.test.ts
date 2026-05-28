/**
 * Unit tests for ModelManager.
 *
 * All file-system and HTTP operations are performed through a mock
 * DownloadAdapter — no native modules or real network calls are needed.
 */

import { ModelManager } from '../src/ModelManager';
import { ModelCache } from '../src/ModelCache';
import type { DownloadAdapter, DownloadFileParams } from '../src/DownloadAdapter';
import { DownloadCancelledError } from '../src/DownloadAdapter';
import {
  ModelDownloadError,
  ModelNotFoundError,
} from '../src/errors';

// ─── Mock global fetch (used by HuggingFaceResolver) ─────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ─── Build a mock DownloadAdapter ─────────────────────────────────────────────

type MockFs = { [path: string]: string | 'DIR' };

function makeAdapter(options: {
  initialFs?: MockFs;
  downloadImpl?: (params: DownloadFileParams) => { status: number };
}) {
  const fs: MockFs = { ...(options.initialFs ?? {}) };
  const DOC_DIR = '/data/user/0/test/files';

  const adapter: DownloadAdapter = {
    getDocumentDir: () => DOC_DIR,

    async exists(path) {
      return path in fs;
    },

    async stat(path) {
      const content = fs[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      const size = content === 'DIR' ? 0 : Buffer.byteLength(content as string, 'utf8');
      return { size };
    },

    async mkdir(path) {
      fs[path] = 'DIR';
    },

    async unlink(path) {
      delete fs[path];
    },

    async readFile(path) {
      const content = fs[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content as string;
    },

    async writeFile(path, content) {
      fs[path] = content;
    },

    async move(src, dest) {
      if (!(src in fs)) throw new Error(`ENOENT: ${src}`);
      fs[dest] = fs[src]!;
      delete fs[src];
    },

    downloadFile(params) {
      const impl = options.downloadImpl ?? (() => ({ status: 200 }));
      let cancelled = false;
      const task = {
        cancel() {
          cancelled = true;
        },
      };

      const done = (async (): Promise<{ status: number }> => {
        if (cancelled) throw new DownloadCancelledError();

        // Simulate writing some bytes to destPath
        fs[params.destPath] = 'FAKE_MODEL_DATA_1234567890';

        // Fire progress once if handler present
        params.onProgress?.(26, 100);

        if (cancelled) throw new DownloadCancelledError();

        return impl(params);
      })();

      return { task, done };
    },
  };

  return { adapter, fs };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManager(options: Parameters<typeof makeAdapter>[0] = {}) {
  const { adapter, fs } = makeAdapter(options);
  const manager = new ModelManager(adapter);
  return { manager, adapter, fs };
}

/** Mock a successful HF API + HEAD response for resolveModelUrl */
function mockHFResolution(filename = 'ggml-model-i2_s.gguf', sizeBytes = 900_000_000) {
  // HF API call
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      siblings: [{ rfilename: filename, size: sizeBytes }],
    }),
    headers: { get: () => null },
  });
}

/** Mock a direct HEAD response for https:// URL */
function mockHeadResponse(size = 900_000_000) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: (h: string) => (h === 'Content-Length' ? String(size) : null) },
  });
}

// ─── downloadModel ────────────────────────────────────────────────────────────

describe('ModelManager.downloadModel', () => {
  beforeEach(() => mockFetch.mockReset());

  test('downloads a model and stores it in the manifest', async () => {
    const { manager } = makeManager();
    mockHFResolution();

    const info = await manager.downloadModel('hf://microsoft/bitnet');
    expect(info.status).toBe('downloaded');
    expect(info.id).toBe('hf://microsoft/bitnet');
    expect(info.localPath).toContain('ggml-model-i2_s.gguf');
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.downloadedAt).toBeDefined();
  });

  test('returns cached model without re-downloading', async () => {
    const modelId = 'hf://microsoft/bitnet';
    const localPath = '/data/user/0/test/files/bitnet-models/ggml-model-i2_s.gguf';

    const { manager, fs } = makeManager();
    // Pre-populate fs with the file
    fs[localPath] = 'FAKE_MODEL';

    // Pre-populate cache by downloading once first
    mockHFResolution();
    await manager.downloadModel(modelId);

    // Second call should NOT call fetch again
    const callsBefore = mockFetch.mock.calls.length;
    await manager.downloadModel(modelId);
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  test('returns same in-flight promise for concurrent calls', async () => {
    const { manager } = makeManager({
      downloadImpl: () => ({ status: 200 }),
    });
    mockHFResolution();

    // Both calls happen synchronously before either has awaited anything.
    // The concurrency guard is registered synchronously so p2 must equal p1.
    const p1 = manager.downloadModel('hf://microsoft/bitnet');
    const p2 = manager.downloadModel('hf://microsoft/bitnet');

    // Verify same promise object (reference equality)
    expect(p1).toBe(p2);

    await p1;
  });

  test('calls onProgress during download', async () => {
    const { manager } = makeManager();
    mockHFResolution();

    const progressEvents: number[] = [];
    await manager.downloadModel('hf://microsoft/bitnet', {
      onProgress: (p) => progressEvents.push(p.bytesReceived),
    });

    expect(progressEvents.length).toBeGreaterThan(0);
  });

  test('supports resume — sends Range header for partial file', async () => {
    const partialPath = '/data/user/0/test/files/bitnet-models/ggml-model-i2_s.gguf.partial';
    const downloadParams: DownloadFileParams[] = [];

    const { adapter } = makeAdapter({
      initialFs: { [partialPath]: 'PARTIAL_DATA' }, // 12 bytes on disk already
      downloadImpl: (p) => {
        downloadParams.push(p);
        return { status: 206 };
      },
    });
    const mgr = new ModelManager(adapter);
    mockHFResolution();

    await mgr.downloadModel('hf://microsoft/bitnet');

    expect(downloadParams[0]?.headers?.['Range']).toMatch(/^bytes=\d+-$/);
    expect(downloadParams[0]?.appendData).toBe(true);
  });

  test('marks model as error when download fails', async () => {
    const { manager } = makeManager({
      downloadImpl: () => { throw new Error('Network error'); },
    });
    mockHFResolution();

    await expect(manager.downloadModel('hf://microsoft/bitnet'))
      .rejects.toBeInstanceOf(ModelDownloadError);

    const models = await manager.listModels();
    expect(models[0]?.status).toBe('error');
  });

  test('throws ModelDownloadError when HTTP status is unexpected', async () => {
    const { manager } = makeManager({
      downloadImpl: () => ({ status: 403 }),
    });
    mockHFResolution();

    await expect(manager.downloadModel('hf://microsoft/bitnet'))
      .rejects.toBeInstanceOf(ModelDownloadError);
  });

  test('throws ModelDownloadError when URL resolution fails', async () => {
    const { manager } = makeManager();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } });

    await expect(manager.downloadModel('hf://bad/repo'))
      .rejects.toBeInstanceOf(ModelDownloadError);
  });

  test('works with direct https:// URL', async () => {
    const { manager } = makeManager();
    mockHeadResponse(500_000_000);

    const info = await manager.downloadModel('https://example.com/model.gguf');
    expect(info.status).toBe('downloaded');
    expect(info.filename ?? info.localPath).toContain('model.gguf');
  });
});

// ─── cancelDownload ───────────────────────────────────────────────────────────

describe('ModelManager.cancelDownload', () => {
  beforeEach(() => mockFetch.mockReset());

  test('cancels an in-progress download', async () => {
    let cancelFn: (() => void) | null = null;

    const adapter = makeAdapter({
      downloadImpl: () => ({ status: 200 }),
    }).adapter;

    // Override downloadFile to expose the cancel function
    adapter.downloadFile = (_params: DownloadFileParams) => {
      const task = {
        cancel() { cancelFn(); },
      };
      const done = new Promise<{ status: number }>((_, reject) => {
        cancelFn = () => {
          reject(new DownloadCancelledError());
        };
        // Never resolves on its own — cancelled by test
      });
      return { task, done };
    };

    const manager = new ModelManager(adapter);
    mockHFResolution();

    const downloadPromise = manager.downloadModel('hf://microsoft/bitnet').catch((e) => e);

    // Give the promise time to start
    await new Promise((r) => setTimeout(r, 10));
    cancelFn?.();

    const result = await downloadPromise;
    expect(result).toBeInstanceOf(ModelDownloadError);
    expect((result as ModelDownloadError).message).toContain('cancel');
  });
});

// ─── isDownloaded ─────────────────────────────────────────────────────────────

describe('ModelManager.isDownloaded', () => {
  beforeEach(() => mockFetch.mockReset());

  test('returns false when not in manifest', async () => {
    const { manager } = makeManager();
    expect(await manager.isDownloaded('hf://unknown/model')).toBe(false);
  });

  test('returns true after successful download', async () => {
    const { manager } = makeManager();
    mockHFResolution();
    await manager.downloadModel('hf://microsoft/bitnet');
    expect(await manager.isDownloaded('hf://microsoft/bitnet')).toBe(true);
  });
});

// ─── getLocalPath ─────────────────────────────────────────────────────────────

describe('ModelManager.getLocalPath', () => {
  beforeEach(() => mockFetch.mockReset());

  test('returns null when not downloaded', () => {
    const { manager } = makeManager();
    expect(manager.getLocalPath('hf://unknown/model')).toBeNull();
  });

  test('returns local path after download', async () => {
    const { manager } = makeManager();
    mockHFResolution();
    const info = await manager.downloadModel('hf://microsoft/bitnet');
    expect(manager.getLocalPath('hf://microsoft/bitnet')).toBe(info.localPath);
  });
});

// ─── listModels ───────────────────────────────────────────────────────────────

describe('ModelManager.listModels', () => {
  beforeEach(() => mockFetch.mockReset());

  test('returns empty array initially', async () => {
    const { manager } = makeManager();
    expect(await manager.listModels()).toEqual([]);
  });

  test('returns downloaded model in list', async () => {
    const { manager } = makeManager();
    mockHFResolution();
    await manager.downloadModel('hf://microsoft/bitnet');
    const list = await manager.listModels();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('hf://microsoft/bitnet');
  });
});

// ─── deleteModel ──────────────────────────────────────────────────────────────

describe('ModelManager.deleteModel', () => {
  beforeEach(() => mockFetch.mockReset());

  test('removes model from manifest and disk', async () => {
    const { manager, fs } = makeManager();
    mockHFResolution();
    const info = await manager.downloadModel('hf://microsoft/bitnet');

    await manager.deleteModel('hf://microsoft/bitnet');

    expect(fs[info.localPath]).toBeUndefined();
    expect(await manager.listModels()).toEqual([]);
  });

  test('throws ModelNotFoundError for unknown model', async () => {
    const { manager } = makeManager();
    await expect(manager.deleteModel('hf://unknown/model'))
      .rejects.toBeInstanceOf(ModelNotFoundError);
  });

  test('succeeds even if file already missing from disk', async () => {
    const { manager, fs } = makeManager();
    mockHFResolution();
    const info = await manager.downloadModel('hf://microsoft/bitnet');

    // Delete file manually from fs
    delete fs[info.localPath];

    // deleteModel should not throw
    await expect(manager.deleteModel('hf://microsoft/bitnet')).resolves.toBeUndefined();
    expect(await manager.listModels()).toEqual([]);
  });
});

// ─── getStorageInfo ───────────────────────────────────────────────────────────

describe('ModelManager.getStorageInfo', () => {
  beforeEach(() => mockFetch.mockReset());

  test('returns zero counts initially', async () => {
    const { manager } = makeManager();
    const info = await manager.getStorageInfo();
    expect(info.totalBytes).toBe(0);
    expect(info.modelCount).toBe(0);
    expect(info.models).toEqual([]);
  });

  test('accumulates sizes after download', async () => {
    const { manager } = makeManager();
    mockHFResolution('model.gguf', 900_000_000);
    await manager.downloadModel('hf://microsoft/bitnet');

    const info = await manager.getStorageInfo();
    expect(info.modelCount).toBe(1);
    // sizeBytes comes from stat() of the written file, which is the fake content length
    expect(info.totalBytes).toBeGreaterThan(0);
  });
});

// ─── ModelCache (unit) ────────────────────────────────────────────────────────

describe('ModelCache', () => {
  test('persists and reloads entries', async () => {
    const { adapter } = makeAdapter({});
    const cache = new ModelCache(adapter);

    await cache.set('model-a', {
      id: 'model-a',
      localPath: '/tmp/model-a.gguf',
      sizeBytes: 100,
      status: 'downloaded',
    });

    // Reload from scratch
    const cache2 = new ModelCache(adapter);
    await cache2.load();
    expect(cache2.get('model-a')?.status).toBe('downloaded');
  });

  test('remove deletes entry and saves', async () => {
    const { adapter } = makeAdapter({});
    const cache = new ModelCache(adapter);

    await cache.set('model-b', {
      id: 'model-b',
      localPath: '/tmp/model-b.gguf',
      sizeBytes: 200,
      status: 'downloaded',
    });
    await cache.remove('model-b');

    const cache2 = new ModelCache(adapter);
    await cache2.load();
    expect(cache2.get('model-b')).toBeUndefined();
  });

  test('getAll returns all entries', async () => {
    const { adapter } = makeAdapter({});
    const cache = new ModelCache(adapter);

    await cache.set('a', { id: 'a', localPath: '/a.gguf', sizeBytes: 1, status: 'downloaded' });
    await cache.set('b', { id: 'b', localPath: '/b.gguf', sizeBytes: 2, status: 'downloaded' });

    expect(cache.getAll()).toHaveLength(2);
  });

  test('handles corrupt manifest gracefully', async () => {
    const manifestPath = '/data/user/0/test/files/bitnet-models/.manifest.json';
    const { adapter } = makeAdapter({
      initialFs: { [manifestPath]: 'NOT_VALID_JSON' },
    });
    const cache = new ModelCache(adapter);

    // Should not throw — starts with empty cache
    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.getAll()).toEqual([]);
  });
});
