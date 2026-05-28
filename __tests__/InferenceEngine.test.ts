/**
 * Unit tests for InferenceEngine.
 *
 * The native module (NativeBitNet) is fully mocked. Tests verify the JS
 * state machine: event routing, concurrency guard, cancellation, error handling,
 * and the async-iterator streaming API.
 */

import { InferenceEngine } from '../src/InferenceEngine';
import { EngineNotInitializedError, ConcurrencyLimitError, InferenceError } from '../src/errors';

// ─── Mock NativeBitNet ────────────────────────────────────────────────────────

const mockStartGeneration = jest.fn();
const mockCancelGeneration = jest.fn();
const mockIsModelLoaded = jest.fn().mockReturnValue(true);
const mockTokenize = jest.fn().mockResolvedValue(5);
const mockGetDeviceInfo = jest.fn().mockReturnValue(
  '{"cpuCount":8,"modelLoaded":true,"contextSize":2048,"arch":"arm64","hasNeon":true}'
);
const mockGetBitNetVersion = jest.fn().mockReturnValue('llama.cpp-b3.0');

jest.mock('../src/NativeBitNet', () => ({
  __esModule: true,
  default: {
    startGeneration: (...args: any[]) => mockStartGeneration(...args),
    cancelGeneration: (...args: any[]) => mockCancelGeneration(...args),
    isModelLoaded: () => mockIsModelLoaded(),
    tokenize: (text: string) => mockTokenize(text),
    getDeviceInfo: () => mockGetDeviceInfo(),
    getBitNetVersion: () => mockGetBitNetVersion(),
  },
}));

// ─── Mock NativeEventEmitter ──────────────────────────────────────────────────

type EventHandler = (event: any) => void;
let _tokenHandler: EventHandler | null = null;

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'BitNetToken') _tokenHandler = handler;
      return { remove: jest.fn() };
    }),
  })),
  NativeModules: { RNBitNet: {} },
  Platform: { OS: 'android' },
}));

// ─── Helper: simulate the native side emitting tokens ────────────────────────

function emitTokens(requestId: string, tokens: string[], delay = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    let i = 0;
    const emit = () => {
      if (i < tokens.length) {
        _tokenHandler?.({ requestId, token: tokens[i]!, done: false, tokenCount: i + 1 });
        i++;
        if (delay > 0) setTimeout(emit, delay);
        else setImmediate(emit);
      } else {
        // emit done
        _tokenHandler?.({ requestId, token: '', done: true, tokenCount: tokens.length });
        resolve();
      }
    };
    if (delay > 0) setTimeout(emit, delay);
    else setImmediate(emit);
  });
}

function emitError(requestId: string, error: string): void {
  _tokenHandler?.({ requestId, token: '', done: false, tokenCount: 0, error });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _tokenHandler = null;
  mockIsModelLoaded.mockReturnValue(true);
  mockStartGeneration.mockResolvedValue(undefined);
});

// ── Basic generation ──────────────────────────────────────────────────────────

describe('InferenceEngine.generate', () => {
  test('returns full text when generation completes', async () => {
    const engine = new InferenceEngine();
    const tokens = ['Hello', ',', ' world', '!'];

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, tokens);
    });

    const result = await engine.generate('prompt');
    expect(result.content).toBe('Hello, world!');
    expect(result.tokenCount).toBe(4);
    engine.dispose();
  });

  test('calls onToken for each token', async () => {
    const engine = new InferenceEngine();
    const received: string[] = [];

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, ['A', 'B', 'C']);
    });

    await engine.generate('prompt', {}, (token) => received.push(token));
    expect(received).toEqual(['A', 'B', 'C']);
    engine.dispose();
  });

  test('passes generation params to native', async () => {
    const engine = new InferenceEngine();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, ['ok']);
    });

    await engine.generate('hello', {
      temperature: 0.5,
      topK: 20,
      topP: 0.9,
      maxTokens: 100,
      seed: 42,
    });

    expect(mockStartGeneration).toHaveBeenCalledWith(
      expect.any(String), // requestId
      'hello',
      0.5,   // temperature
      20,    // topK
      0.9,   // topP
      100,   // maxTokens
      1.1,   // repetitionPenalty (default)
      '[]',  // stopSequences
      42     // seed
    );
    engine.dispose();
  });

  test('reports durationMs and tokensPerSecond', async () => {
    const engine = new InferenceEngine();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, ['t', 'o', 'k', 'e', 'n']);
    });

    const result = await engine.generate('prompt');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensPerSecond).toBeGreaterThanOrEqual(0);
    engine.dispose();
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('InferenceEngine — error handling', () => {
  test('throws EngineNotInitializedError when no model loaded', async () => {
    mockIsModelLoaded.mockReturnValue(false);
    const engine = new InferenceEngine();
    await expect(engine.generate('prompt')).rejects.toBeInstanceOf(EngineNotInitializedError);
    engine.dispose();
  });

  test('throws InferenceError on native error event', async () => {
    const engine = new InferenceEngine();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      setImmediate(() => emitError(requestId, 'llama_decode failed'));
    });

    await expect(engine.generate('prompt')).rejects.toBeInstanceOf(InferenceError);
    engine.dispose();
  });

  test('throws InferenceError when startGeneration rejects', async () => {
    const engine = new InferenceEngine();
    mockStartGeneration.mockRejectedValue(new Error('native crash'));
    await expect(engine.generate('prompt')).rejects.toBeInstanceOf(InferenceError);
    engine.dispose();
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('InferenceEngine — concurrency', () => {
  test('throws ConcurrencyLimitError when at max (default 1)', async () => {
    const engine = new InferenceEngine(1);

    // Start one that never resolves on its own
    let resolveFirst: (() => void) | null = null;
    mockStartGeneration.mockImplementationOnce(async (requestId: string) => {
      await new Promise<void>(r => { resolveFirst = r; });
      emitTokens(requestId, ['x']);
    });

    const first = engine.generate('prompt1');

    // Small delay to ensure first is registered
    await new Promise(r => setImmediate(r));

    await expect(engine.generate('prompt2')).rejects.toBeInstanceOf(ConcurrencyLimitError);

    // Resolve the first one
    resolveFirst?.();
    await first.catch(() => {});
    engine.dispose();
  });

  test('allows second request after first completes', async () => {
    const engine = new InferenceEngine(1);

    mockStartGeneration
      .mockImplementationOnce(async (requestId: string) => { emitTokens(requestId, ['A']); })
      .mockImplementationOnce(async (requestId: string) => { emitTokens(requestId, ['B']); });

    const r1 = await engine.generate('p1');
    const r2 = await engine.generate('p2');

    expect(r1.content).toBe('A');
    expect(r2.content).toBe('B');
    engine.dispose();
  });

  test('maxConcurrency=2 allows two simultaneous requests', async () => {
    const engine = new InferenceEngine(2);

    mockStartGeneration
      .mockImplementationOnce(async (requestId: string) => {
        setTimeout(() => emitTokens(requestId, ['one']), 10);
      })
      .mockImplementationOnce(async (requestId: string) => {
        setTimeout(() => emitTokens(requestId, ['two']), 10);
      });

    const [r1, r2] = await Promise.all([
      engine.generate('p1'),
      engine.generate('p2'),
    ]);

    expect(r1.content).toBe('one');
    expect(r2.content).toBe('two');
    engine.dispose();
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe('InferenceEngine — cancellation', () => {
  test('cancel() calls nativeCancelGeneration', async () => {
    const engine = new InferenceEngine();
    let capturedId = '';

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      capturedId = requestId;
      // Simulate long generation
      setTimeout(() => emitTokens(requestId, ['done']), 500);
    });

    void engine.generate('prompt').catch(() => {});
    await new Promise(r => setImmediate(r));

    engine.cancel(capturedId);
    expect(mockCancelGeneration).toHaveBeenCalledWith(capturedId);
    engine.dispose();
  });

  test('AbortSignal cancels generation', async () => {
    const engine = new InferenceEngine();
    const controller = new AbortController();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      setTimeout(() => emitTokens(requestId, ['done']), 200);
    });

    const resultPromise = engine.generate('prompt', {}, undefined, controller.signal).catch(e => e);

    controller.abort();
    await resultPromise;
    expect(mockCancelGeneration).toHaveBeenCalled();
    engine.dispose();
  });

  test('AbortSignal that is already aborted throws immediately', async () => {
    const engine = new InferenceEngine();
    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.generate('prompt', {}, undefined, controller.signal)
    ).rejects.toBeInstanceOf(InferenceError);
    engine.dispose();
  });
});

// ── Async iterator (generateStream) ──────────────────────────────────────────

describe('InferenceEngine.generateStream', () => {
  test('yields each token as a chunk', async () => {
    const engine = new InferenceEngine();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, ['H', 'i', '!']);
    });

    const chunks: string[] = [];
    for await (const chunk of engine.generateStream('prompt')) {
      if (!chunk.done) chunks.push(chunk.delta);
    }
    expect(chunks).toEqual(['H', 'i', '!']);
    engine.dispose();
  });

  test('last chunk has done=true', async () => {
    const engine = new InferenceEngine();

    mockStartGeneration.mockImplementation(async (requestId: string) => {
      emitTokens(requestId, ['x']);
    });

    const chunks = [];
    for await (const chunk of engine.generateStream('prompt')) {
      chunks.push(chunk);
    }
    expect(chunks[chunks.length - 1]?.done).toBe(true);
    engine.dispose();
  });
});

// ── Utilities ─────────────────────────────────────────────────────────────────

describe('InferenceEngine — utilities', () => {
  test('getDeviceInfo returns parsed object', () => {
    const engine = new InferenceEngine();
    const info = engine.getDeviceInfo();
    expect(info.cpuCount).toBe(8);
    expect(info.hasNeon).toBe(true);
    engine.dispose();
  });

  test('getBitNetVersion returns string', () => {
    const engine = new InferenceEngine();
    expect(engine.getBitNetVersion()).toBe('llama.cpp-b3.0');
    engine.dispose();
  });

  test('tokenCount calls native tokenize', async () => {
    const engine = new InferenceEngine();
    const count = await engine.tokenCount('hello world');
    expect(count).toBe(5);
    expect(mockTokenize).toHaveBeenCalledWith('hello world');
    engine.dispose();
  });
});
