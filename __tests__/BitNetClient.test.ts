/**
 * Stage 1 + 2 unit tests — BitNetClient JS layer.
 *
 * All native modules are mocked; tests run without a device or compiled .so.
 */

// ─── Mock NativeBitNet (self-contained factory — no external variable refs) ───
// jest.mock factories are hoisted above variable declarations. Using const/let
// variables declared in the same file would be in the temporal dead zone when
// the factory runs. We therefore keep the factory self-contained and capture
// mock references afterwards via jest.requireMock().

jest.mock('../src/NativeBitNet', () => ({
  __esModule: true,
  default: {
    loadModel: jest.fn().mockResolvedValue(true),
    unloadModel: jest.fn().mockResolvedValue(null),
    isModelLoaded: jest.fn().mockReturnValue(false),
    startGeneration: jest.fn().mockResolvedValue(null),
    cancelGeneration: jest.fn(),
    tokenize: jest.fn().mockResolvedValue(42),
    getDeviceInfo: jest.fn().mockReturnValue('{"cpuCount":8,"modelLoaded":false}'),
    getBitNetVersion: jest.fn().mockReturnValue('llama.cpp-b3.x'),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

// ─── Mock ModelManager so it never touches react-native-blob-util ─────────────

jest.mock('../src/ModelManager', () => ({
  ModelManager: jest.fn().mockImplementation(() => ({
    downloadModel: jest.fn().mockResolvedValue({
      id: 'test', localPath: '/tmp/model.gguf', sizeBytes: 1, status: 'downloaded',
    }),
    cancelDownload: jest.fn(),
    isDownloaded: jest.fn().mockResolvedValue(true),
    listModels: jest.fn().mockResolvedValue([]),
    deleteModel: jest.fn().mockResolvedValue(undefined),
    getStorageInfo: jest.fn().mockResolvedValue({ totalBytes: 0, modelCount: 0, models: [] }),
    getLocalPath: jest.fn().mockReturnValue('/tmp/model.gguf'),
    getCache: jest.fn(),
  })),
}));

// ─── Minimal react-native mock (avoids loading real native modules) ───────────

jest.mock('react-native', () => ({
  NativeEventEmitter: class {
    addListener = jest.fn().mockReturnValue({ remove: jest.fn() });
    removeAllListeners = jest.fn();
  },
  NativeModules: {},
  Platform: { OS: 'android' },
}));

// ─── Capture mock references after module registration ────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockNative: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MockModelManager: jest.Mock<any>;

beforeAll(() => {
  mockNative = jest.requireMock('../src/NativeBitNet').default;
  MockModelManager = jest.requireMock('../src/ModelManager').ModelManager;
});

// ─── Imports (must come after jest.mock calls) ────────────────────────────────

import { BitNetClient } from '../src/BitNetClient';
import { formatChatPrompt } from '../src/ChatTemplate';
import {
  EngineNotInitializedError,
  ModelLoadError,
} from '../src/errors';

// ─── BitNetClient tests ───────────────────────────────────────────────────────

describe('BitNetClient', () => {
  let client: BitNetClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new BitNetClient({ threads: 4, contextSize: 512 });
  });

  afterEach(() => {
    client.dispose();
  });

  // ── loadModel ──────────────────────────────────────────────────────────────

  test('loadModel calls nativeLoadModel with correct params', async () => {
    await client.loadModel('/path/to/model.gguf');
    expect(mockNative.loadModel).toHaveBeenCalledWith(
      '/path/to/model.gguf',
      4,     // threads
      512,   // contextSize
      512    // batchSize (default)
    );
  });

  test('loadModel throws ModelLoadError on native failure', async () => {
    mockNative.loadModel.mockRejectedValueOnce(new Error('file not found'));
    await expect(client.loadModel('/bad/path')).rejects.toBeInstanceOf(ModelLoadError);
  });

  test('loadModel resolves hf:// ID via ModelManager.getLocalPath', async () => {
    // MockModelManager.getLocalPath returns '/tmp/model.gguf' by default
    await client.loadModel('hf://microsoft/bitnet');
    expect(mockNative.loadModel).toHaveBeenCalledWith('/tmp/model.gguf', 4, 512, 512);
  });

  test('loadModel throws ModelLoadError when hf:// model not cached', async () => {
    // Override getLocalPath to return null for this test
    const instance = MockModelManager.mock.results[MockModelManager.mock.results.length - 1]?.value;
    if (instance) {
      instance.getLocalPath.mockReturnValueOnce(null);
    }
    await expect(client.loadModel('hf://microsoft/unknown')).rejects.toBeInstanceOf(ModelLoadError);
  });

  // ── isModelLoaded ──────────────────────────────────────────────────────────

  test('isModelLoaded reflects native value', () => {
    mockNative.isModelLoaded.mockReturnValueOnce(true);
    expect(client.isModelLoaded()).toBe(true);
    mockNative.isModelLoaded.mockReturnValueOnce(false);
    expect(client.isModelLoaded()).toBe(false);
  });

  // ── generateStream ─────────────────────────────────────────────────────────

  test('generateStream throws EngineNotInitializedError if no model loaded', async () => {
    mockNative.isModelLoaded.mockReturnValue(false);
    const stream = client.generateStream('hello');
    await expect(async () => {
      for await (const _ of stream) { /* empty */ }
    }).rejects.toBeInstanceOf(EngineNotInitializedError);
  });

  // ── countTokens ────────────────────────────────────────────────────────────

  test('countTokens calls nativeTokenize and returns count', async () => {
    const count = await client.countTokens('Hello world');
    expect(mockNative.tokenize).toHaveBeenCalledWith('Hello world');
    expect(count).toBe(42);
  });

  // ── getDeviceInfo ──────────────────────────────────────────────────────────

  test('getDeviceInfo returns parsed object', () => {
    const info = client.getDeviceInfo();
    expect(info).toHaveProperty('cpuCount', 8);
  });

  // ── getBitNetVersion ───────────────────────────────────────────────────────

  test('getBitNetVersion returns string', () => {
    expect(client.getBitNetVersion()).toBe('llama.cpp-b3.x');
  });

  // ── Model management delegation (Stage 2) ──────────────────────────────────

  test('downloadModel delegates to ModelManager', async () => {
    const instance = MockModelManager.mock.results[MockModelManager.mock.results.length - 1]?.value;
    await client.downloadModel('hf://microsoft/bitnet');
    expect(instance?.downloadModel).toHaveBeenCalledWith('hf://microsoft/bitnet', {});
  });

  test('listModels delegates to ModelManager', async () => {
    const models = await client.listModels();
    expect(models).toEqual([]);
  });

  test('getStorageInfo delegates to ModelManager', async () => {
    const info = await client.getStorageInfo();
    expect(info.totalBytes).toBe(0);
  });
});

// ─── formatChatPrompt (ChatML / chatml template) ──────────────────────────────

describe('formatChatPrompt — chatml', () => {
  test('formats a single user message correctly', () => {
    const result = formatChatPrompt([{ role: 'user', content: 'Hello' }], 'chatml');
    expect(result).toContain('<|im_start|>user\nHello<|im_end|>');
    expect(result).toMatch(/<\|im_start\|>assistant\n$/);
  });

  test('includes system prompt when provided', () => {
    const result = formatChatPrompt([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ], 'chatml');
    expect(result).toContain('<|im_start|>system\nYou are helpful.<|im_end|>');
    expect(result).toContain('<|im_start|>user\nHi<|im_end|>');
    expect(result).toMatch(/<\|im_start\|>assistant\n$/);
  });

  test('includes multi-turn history', () => {
    const result = formatChatPrompt([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ], 'chatml');
    expect(result).toContain('<|im_start|>assistant\nA1<|im_end|>');
  });
});

// ─── Error classes ────────────────────────────────────────────────────────────

describe('Error types', () => {
  test('ModelLoadError has correct code and message', () => {
    const err = new ModelLoadError('/bad/path', 'file not found');
    expect(err.code).toBe('MODEL_LOAD_FAILED');
    expect(err.modelId).toBe('/bad/path');
    expect(err.message).toContain('file not found');
    expect(err).toBeInstanceOf(Error);
  });

  test('EngineNotInitializedError has correct code', () => {
    const err = new EngineNotInitializedError();
    expect(err.code).toBe('ENGINE_NOT_INITIALIZED');
    expect(err.message).toContain('loadModel');
  });
});
