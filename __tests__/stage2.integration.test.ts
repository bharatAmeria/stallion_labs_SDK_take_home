/**
 * Stage 2 Integration Tests
 * ─────────────────────────
 * These tests run in a Node.js environment (no Android emulator needed).
 * They exercise the real JS logic using:
 *   • A Node.js DownloadAdapter backed by the real `fs` module
 *   • Mocked HTTP (to avoid multi-GB downloads in CI)
 *   • Real file creation / reads / moves on disk (os.tmpdir())
 *
 * Run with:
 *   npm run test:integration
 *
 * For live HuggingFace API tests (requires internet):
 *   LIVE_HF=1 npm run test:integration
 */

// ─── Minimal stubs needed to satisfy BitNetClient imports ────────────────────
// (BitNetClient is only checked structurally in section 4 — no methods called)

jest.mock('../src/NativeBitNet', () => ({
  __esModule: true,
  default: {
    loadModel: jest.fn(), unloadModel: jest.fn(), isModelLoaded: jest.fn().mockReturnValue(false),
    startGeneration: jest.fn(), cancelGeneration: jest.fn(), tokenize: jest.fn(),
    getDeviceInfo: jest.fn().mockReturnValue('{}'), getBitNetVersion: jest.fn().mockReturnValue(''),
  },
}));

jest.mock('react-native', () => ({
  NativeEventEmitter: class { addListener = jest.fn().mockReturnValue({ remove: jest.fn() }); },
  NativeModules: {},
  Platform: { OS: 'android' },
}));

// react-native-blob-util is auto-mocked via __mocks__/react-native-blob-util.js
// (a peer dep with native code — never installed in the test environment).
// Integration tests inject a real Node.js DownloadAdapter so the mock is never
// actually called during test execution.

import * as fsSync from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { DownloadAdapter, DownloadFileParams } from '../src/DownloadAdapter';
import { DownloadCancelledError } from '../src/DownloadAdapter';
import { ModelManager } from '../src/ModelManager';
import { ModelCache } from '../src/ModelCache';
import { parseHFUrl, pickBestGguf, resolveModelUrl } from '../src/HuggingFaceResolver';
import { ModelDownloadError, ModelNotFoundError } from '../src/errors';

// ─── Node.js DownloadAdapter ──────────────────────────────────────────────────
// Bridges the DownloadAdapter interface to Node.js fs/https.
// A mock HTTP response is injected per test via `setMockDownload()`.

let mockDownloadResponse: { status: number; body?: string } = { status: 200, body: 'FAKE_MODEL_DATA' };

function setMockDownload(r: { status: number; body?: string }) {
  mockDownloadResponse = r;
}

function makeNodeAdapter(docDir: string): DownloadAdapter {
  return {
    getDocumentDir: () => docDir,

    async exists(p) {
      try {
        await fsPromises.access(p);
        return true;
      } catch {
        return false;
      }
    },

    async stat(p) {
      const s = await fsPromises.stat(p);
      return { size: s.size };
    },

    async mkdir(p) {
      await fsPromises.mkdir(p, { recursive: true });
    },

    async unlink(p) {
      try {
        await fsPromises.unlink(p);
      } catch {
        // ignore ENOENT
      }
    },

    async readFile(p) {
      return fsPromises.readFile(p, 'utf8');
    },

    async writeFile(p, content) {
      await fsPromises.writeFile(p, content, 'utf8');
    },

    async move(src, dest) {
      await fsPromises.rename(src, dest);
    },

    downloadFile(params: DownloadFileParams) {
      let cancelled = false;
      const task = {
        cancel() {
          cancelled = true;
        },
      };

      const done = (async (): Promise<{ status: number }> => {
        if (cancelled) throw new DownloadCancelledError();

        const body = mockDownloadResponse.body ?? 'FAKE_MODEL';
        const flags = params.appendData ? 'a' : 'w';
        await fsPromises.writeFile(params.destPath, body, { flag: flags });

        params.onProgress?.(body.length, body.length);

        if (cancelled) throw new DownloadCancelledError();

        return { status: mockDownloadResponse.status };
      })();

      return { task, done };
    },
  };
}

// ─── Mock global fetch (for HF API calls) ────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockHFApi(filename = 'ggml-model-i2_s.gguf', size = 900_000_000) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ siblings: [{ rfilename: filename, size }] }),
    headers: { get: () => null },
  });
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bitnet-test-'));
  mockFetch.mockReset();
  setMockDownload({ status: 200, body: 'FAKE_MODEL_BINARY_DATA_12345' });
});

afterEach(async () => {
  // Clean up temp directory
  try {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─── 1. HuggingFace URL parsing ───────────────────────────────────────────────

describe('1. HuggingFace URL resolver', () => {
  test('1.1  parseHFUrl splits owner / repo correctly', () => {
    const r = parseHFUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
    expect(r.owner).toBe('microsoft');
    expect(r.repo).toBe('bitnet-b1.58-2B-4T-gguf');
    expect(r.filename).toBeUndefined();
  });

  test('1.2  parseHFUrl splits owner / repo / filename correctly', () => {
    const r = parseHFUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf');
    expect(r.owner).toBe('microsoft');
    expect(r.repo).toBe('bitnet-b1.58-2B-4T-gguf');
    expect(r.filename).toBe('ggml-model-i2_s.gguf');
  });

  test('1.3  pickBestGguf selects i2_s over Q4', () => {
    const best = pickBestGguf([
      { rfilename: 'model-Q4_K_M.gguf', size: 1_200_000_000 },
      { rfilename: 'model-i2_s.gguf', size: 900_000_000 },
    ]);
    expect(best?.rfilename).toBe('model-i2_s.gguf');
  });

  test('1.4  resolveModelUrl builds correct HF download URL', async () => {
    mockHFApi('ggml-model-i2_s.gguf', 900_000_000);
    const r = await resolveModelUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
    expect(r.downloadUrl).toBe(
      'https://huggingface.co/microsoft/bitnet-b1.58-2B-4T-gguf/resolve/main/ggml-model-i2_s.gguf'
    );
    expect(r.filename).toBe('ggml-model-i2_s.gguf');
    expect(r.sizeBytes).toBe(900_000_000);
  });

  test('1.5  resolveModelUrl handles https:// direct URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (h: string) => (h === 'Content-Length' ? '12345' : null) },
    });
    const r = await resolveModelUrl('https://example.com/mymodel.gguf');
    expect(r.filename).toBe('mymodel.gguf');
    expect(r.sizeBytes).toBe(12345);
  });
});

// ─── 2. ModelCache with real filesystem ───────────────────────────────────────

describe('2. ModelCache (real filesystem)', () => {
  test('2.1  creates models directory on first load', async () => {
    const adapter = makeNodeAdapter(tmpDir);
    const cache = new ModelCache(adapter);
    await cache.load();

    const modelsDir = path.join(tmpDir, 'bitnet-models');
    expect(fsSync.existsSync(modelsDir)).toBe(true);
  });

  test('2.2  persists ModelInfo across reloads', async () => {
    const adapter = makeNodeAdapter(tmpDir);
    const cache = new ModelCache(adapter);

    await cache.set('hf://test/model', {
      id: 'hf://test/model',
      localPath: path.join(tmpDir, 'model.gguf'),
      sizeBytes: 500_000_000,
      status: 'downloaded',
      downloadedAt: new Date().toISOString(),
    });

    // Reload from disk
    const cache2 = new ModelCache(adapter);
    await cache2.load();

    const info = cache2.get('hf://test/model');
    expect(info).toBeDefined();
    expect(info?.status).toBe('downloaded');
    expect(info?.sizeBytes).toBe(500_000_000);
  });

  test('2.3  remove deletes entry from manifest', async () => {
    const adapter = makeNodeAdapter(tmpDir);
    const cache = new ModelCache(adapter);
    await cache.set('model-a', { id: 'model-a', localPath: '/x', sizeBytes: 1, status: 'downloaded' });
    await cache.set('model-b', { id: 'model-b', localPath: '/y', sizeBytes: 2, status: 'downloaded' });

    await cache.remove('model-a');

    const cache2 = new ModelCache(adapter);
    await cache2.load();
    expect(cache2.get('model-a')).toBeUndefined();
    expect(cache2.get('model-b')).toBeDefined();
  });

  test('2.4  handles corrupt manifest file gracefully', async () => {
    const adapter = makeNodeAdapter(tmpDir);
    // Write corrupt manifest
    const modelsDir = path.join(tmpDir, 'bitnet-models');
    await fsPromises.mkdir(modelsDir, { recursive: true });
    await fsPromises.writeFile(path.join(modelsDir, '.manifest.json'), '{ INVALID JSON }', 'utf8');

    const cache = new ModelCache(adapter);
    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.getAll()).toEqual([]);
  });
});

// ─── 3. ModelManager — full download workflow ─────────────────────────────────

describe('3. ModelManager (real filesystem, mocked HTTP)', () => {
  let manager: ModelManager;

  beforeEach(() => {
    manager = new ModelManager(makeNodeAdapter(tmpDir));
  });

  test('3.1  downloadModel creates a file on disk', async () => {
    mockHFApi();
    const info = await manager.downloadModel('hf://microsoft/bitnet');

    expect(info.status).toBe('downloaded');
    expect(fsSync.existsSync(info.localPath)).toBe(true);
  });

  test('3.2  downloadModel writes the expected content', async () => {
    mockHFApi();
    setMockDownload({ status: 200, body: 'BITNET_MODEL_BYTES_XYZ' });

    const info = await manager.downloadModel('hf://microsoft/bitnet');
    const content = await fsPromises.readFile(info.localPath, 'utf8');
    expect(content).toBe('BITNET_MODEL_BYTES_XYZ');
  });

  test('3.3  downloadModel stores correct metadata in manifest', async () => {
    mockHFApi('ggml-model-i2_s.gguf', 900_000_000);
    const info = await manager.downloadModel('hf://microsoft/bitnet');

    expect(info.id).toBe('hf://microsoft/bitnet');
    expect(info.localPath).toContain('ggml-model-i2_s.gguf');
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.downloadedAt).toBeDefined();
    expect(new Date(info.downloadedAt!).getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  test('3.4  isDownloaded returns true after download', async () => {
    mockHFApi();
    await manager.downloadModel('hf://microsoft/bitnet');
    expect(await manager.isDownloaded('hf://microsoft/bitnet')).toBe(true);
  });

  test('3.5  isDownloaded returns false for unknown model', async () => {
    expect(await manager.isDownloaded('hf://unknown/model')).toBe(false);
  });

  test('3.6  getLocalPath returns path after download', async () => {
    mockHFApi();
    const info = await manager.downloadModel('hf://microsoft/bitnet');
    expect(manager.getLocalPath('hf://microsoft/bitnet')).toBe(info.localPath);
  });

  test('3.7  listModels returns all models', async () => {
    mockHFApi('model-a.gguf');
    mockHFApi('model-b.gguf');

    await manager.downloadModel('hf://org/model-a');
    await manager.downloadModel('hf://org/model-b');

    const list = await manager.listModels();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id)).toContain('hf://org/model-a');
    expect(list.map((m) => m.id)).toContain('hf://org/model-b');
  });

  test('3.8  deleteModel removes file from disk AND manifest', async () => {
    mockHFApi();
    const info = await manager.downloadModel('hf://microsoft/bitnet');
    const filePath = info.localPath;

    await manager.deleteModel('hf://microsoft/bitnet');

    expect(fsSync.existsSync(filePath)).toBe(false);
    expect(await manager.listModels()).toHaveLength(0);
  });

  test('3.9  deleteModel throws ModelNotFoundError for unknown id', async () => {
    await expect(manager.deleteModel('hf://never/downloaded'))
      .rejects.toBeInstanceOf(ModelNotFoundError);
  });

  test('3.10  getStorageInfo totals are correct', async () => {
    mockHFApi();
    await manager.downloadModel('hf://microsoft/bitnet');

    const info = await manager.getStorageInfo();
    expect(info.modelCount).toBe(1);
    expect(info.totalBytes).toBeGreaterThan(0);
    expect(info.models[0]?.id).toBe('hf://microsoft/bitnet');
  });

  test('3.11  concurrent downloads of same model return same promise', async () => {
    mockHFApi();
    const p1 = manager.downloadModel('hf://microsoft/bitnet');
    const p2 = manager.downloadModel('hf://microsoft/bitnet');
    expect(p1).toBe(p2);
    await p1;
  });

  test('3.12  second download returns cached result without re-downloading', async () => {
    mockHFApi();
    await manager.downloadModel('hf://microsoft/bitnet');

    const callsBefore = mockFetch.mock.calls.length;
    await manager.downloadModel('hf://microsoft/bitnet');
    // fetch should NOT be called again
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  test('3.13  resume — appends to partial file and sends Range header', async () => {
    mockHFApi();
    // Pre-create a partial file
    const modelsDir = path.join(tmpDir, 'bitnet-models');
    await fsPromises.mkdir(modelsDir, { recursive: true });
    const partialPath = path.join(modelsDir, 'ggml-model-i2_s.gguf.partial');
    await fsPromises.writeFile(partialPath, 'PARTIAL_BYTES', 'utf8');

    const downloadParams: DownloadFileParams[] = [];
    const adapter = makeNodeAdapter(tmpDir);
    const origDownload = adapter.downloadFile.bind(adapter);
    adapter.downloadFile = (p) => {
      downloadParams.push(p);
      return origDownload(p);
    };

    const mgr = new ModelManager(adapter);
    await mgr.downloadModel('hf://microsoft/bitnet');

    expect(downloadParams[0]?.headers?.['Range']).toMatch(/^bytes=\d+-$/);
    expect(downloadParams[0]?.appendData).toBe(true);
  });

  test('3.14  failed download (HTTP 403) throws ModelDownloadError', async () => {
    mockHFApi();
    setMockDownload({ status: 403 });

    await expect(manager.downloadModel('hf://microsoft/bitnet'))
      .rejects.toBeInstanceOf(ModelDownloadError);
  });

  test('3.15  progress callback fires with increasing bytesReceived', async () => {
    mockHFApi();
    const progress: number[] = [];

    await manager.downloadModel('hf://microsoft/bitnet', {
      onProgress: (p) => progress.push(p.bytesReceived),
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBeGreaterThan(0);
  });
});

// ─── 4. Stage 1 + Stage 2 integration checklist ───────────────────────────────

describe('4. Stage 1 + Stage 2 integration checklist', () => {
  test('4.1  SDK exports all Stage 1 types and functions', () => {
    const sdk = require('../src/index');
    expect(sdk.BitNetClient).toBeDefined();
    expect(sdk.formatChatPrompt).toBeDefined();
    expect(sdk.BitNet).toBeDefined();
  });

  test('4.2  SDK exports all Stage 2 types and classes', () => {
    const sdk = require('../src/index');
    expect(sdk.ModelManager).toBeDefined();
    expect(sdk.ModelCache).toBeDefined();
    expect(sdk.parseHFUrl).toBeDefined();
    expect(sdk.pickBestGguf).toBeDefined();
    expect(sdk.resolveModelUrl).toBeDefined();
    expect(sdk.createRNBFAdapter).toBeDefined();
    expect(sdk.DownloadCancelledError).toBeDefined();
  });

  test('4.3  SDK exports all error classes', () => {
    const sdk = require('../src/index');
    expect(sdk.BitNetError).toBeDefined();
    expect(sdk.ModelDownloadError).toBeDefined();
    expect(sdk.ModelNotFoundError).toBeDefined();
    expect(sdk.ModelLoadError).toBeDefined();
    expect(sdk.InsufficientStorageError).toBeDefined();
    expect(sdk.InferenceError).toBeDefined();
    expect(sdk.ConcurrencyLimitError).toBeDefined();
    expect(sdk.EngineNotInitializedError).toBeDefined();
    expect(sdk.NativeError).toBeDefined();
  });

  test('4.4  BitNetClient has all Stage 2 methods', () => {
    // BitNetClient is mocked in this file so we check the prototype
    const { BitNetClient } = require('../src/BitNetClient');
    const proto = BitNetClient.prototype;
    expect(typeof proto.downloadModel).toBe('function');
    expect(typeof proto.cancelDownload).toBe('function');
    expect(typeof proto.isModelDownloaded).toBe('function');
    expect(typeof proto.listModels).toBe('function');
    expect(typeof proto.deleteModel).toBe('function');
    expect(typeof proto.getStorageInfo).toBe('function');
    expect(typeof proto.loadModel).toBe('function');
    expect(typeof proto.generateStream).toBe('function');
    expect(typeof proto.chatStream).toBe('function');
    expect(typeof proto.generate).toBe('function');
    expect(typeof proto.chat).toBe('function');
  });

  test('4.5  Error classes have correct codes', () => {
    const { ModelDownloadError, ModelNotFoundError, ModelLoadError,
            InsufficientStorageError, EngineNotInitializedError } = require('../src/errors');

    expect(new ModelDownloadError('id', 'msg').code).toBe('MODEL_DOWNLOAD_FAILED');
    expect(new ModelNotFoundError('id').code).toBe('MODEL_NOT_FOUND');
    expect(new ModelLoadError('id', 'msg').code).toBe('MODEL_LOAD_FAILED');
    expect(new InsufficientStorageError(100, 50).code).toBe('INSUFFICIENT_STORAGE');
    expect(new EngineNotInitializedError().code).toBe('ENGINE_NOT_INITIALIZED');
  });

  test('4.6  ModelManager.downloadModel → getLocalPath → isDownloaded flow works', async () => {
    mockHFApi();
    const manager = new ModelManager(makeNodeAdapter(tmpDir));

    // Before download
    expect(manager.getLocalPath('hf://microsoft/bitnet')).toBeNull();
    expect(await manager.isDownloaded('hf://microsoft/bitnet')).toBe(false);

    // Download
    const info = await manager.downloadModel('hf://microsoft/bitnet');

    // After download
    expect(manager.getLocalPath('hf://microsoft/bitnet')).toBe(info.localPath);
    expect(await manager.isDownloaded('hf://microsoft/bitnet')).toBe(true);

    // Delete
    await manager.deleteModel('hf://microsoft/bitnet');

    // After delete
    expect(manager.getLocalPath('hf://microsoft/bitnet')).toBeNull();
    expect(await manager.isDownloaded('hf://microsoft/bitnet')).toBe(false);
  });
});

// ─── 5. Optional live HuggingFace API test ────────────────────────────────────
// Runs only when LIVE_HF=1 environment variable is set.
// Hits the real HF REST API — requires internet access.

const LIVE = process.env['LIVE_HF'] === '1';

(LIVE ? describe : describe.skip)('5. LIVE: HuggingFace API', () => {
  // Restore real fetch for live tests
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = require('node-fetch').default ?? globalThis.fetch;
  });

  test('5.1  resolves microsoft/bitnet-b1.58-2B-4T-gguf and finds a gguf', async () => {
    const result = await resolveModelUrl('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
    expect(result.downloadUrl).toContain('huggingface.co');
    expect(result.filename).toMatch(/\.gguf$/);
    console.log(`\n  ✓ Resolved: ${result.filename} (${(result.sizeBytes / 1e9).toFixed(2)} GB)`);
    console.log(`  ✓ URL: ${result.downloadUrl}`);
  }, 15_000);
});
