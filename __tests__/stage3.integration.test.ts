/**
 * Stage 3 Integration Tests — Inference API
 *
 * Tests the full JS pipeline end-to-end:
 *   ChatTemplate → InferenceEngine → BitNetClient
 *
 * The native module is mocked. All logic under test is pure TypeScript.
 *
 * Run with:
 *   npm run test:integration
 */

import { formatChatPrompt, inferChatTemplate } from '../src/ChatTemplate';
import { InferenceEngine } from '../src/InferenceEngine';
import { BitNetClient } from '../src/BitNetClient';
import {
  EngineNotInitializedError,
  ConcurrencyLimitError,
  InferenceError,
} from '../src/errors';
import type { ChatCompletionChunk, ChatMessage } from '../src/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockStart  = jest.fn();
const mockCancel = jest.fn();
const mockLoaded = jest.fn().mockReturnValue(true);
const mockTokenize = jest.fn().mockResolvedValue(10);

jest.mock('../src/NativeBitNet', () => ({
  __esModule: true,
  default: {
    startGeneration:  (...a: any[]) => mockStart(...a),
    cancelGeneration: (...a: any[]) => mockCancel(...a),
    isModelLoaded:    () => mockLoaded(),
    tokenize:         (t: string) => mockTokenize(t),
    loadModel:        jest.fn().mockResolvedValue(true),
    unloadModel:      jest.fn().mockResolvedValue(undefined),
    getDeviceInfo:    () => '{"cpuCount":8,"modelLoaded":true,"contextSize":2048,"arch":"arm64","hasNeon":true}',
    getBitNetVersion: () => 'llama.cpp-b3.0',
  },
}));

type TokenHandler = (e: any) => void;
let _handler: TokenHandler | null = null;

jest.mock('react-native', () => ({
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn().mockImplementation((event: string, h: TokenHandler) => {
      if (event === 'BitNetToken') _handler = h;
      return { remove: jest.fn() };
    }),
  })),
  NativeModules: { RNBitNet: {} },
  Platform: { OS: 'android' },
}));

// ─── Helper: simulate native emitting tokens ──────────────────────────────────

function emit(requestId: string, tokens: string[]): void {
  let i = 0;
  const next = () => {
    if (i < tokens.length) {
      _handler?.({ requestId, token: tokens[i++]!, done: false, tokenCount: i });
      setImmediate(next);
    } else {
      _handler?.({ requestId, token: '', done: true, tokenCount: tokens.length });
    }
  };
  setImmediate(next);
}

beforeEach(() => {
  jest.clearAllMocks();
  _handler = null;
  mockLoaded.mockReturnValue(true);
  mockStart.mockImplementation(async (id: string) => emit(id, ['Hello', ',', ' world', '!']));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. ChatTemplate
// ═══════════════════════════════════════════════════════════════════════════

describe('1. ChatTemplate — prompt formatting', () => {

  test('1.1  llama3 wraps messages with header tokens', () => {
    const prompt = formatChatPrompt([
      { role: 'system',    content: 'Be helpful.' },
      { role: 'user',      content: 'Hello!' },
    ], 'llama3');
    expect(prompt).toContain('<|begin_of_text|>');
    expect(prompt).toContain('<|start_header_id|>system<|end_header_id|>');
    expect(prompt).toContain('Be helpful.');
    expect(prompt).toContain('<|start_header_id|>user<|end_header_id|>');
    expect(prompt).toContain('Hello!');
    expect(prompt).toMatch(/<\|start_header_id\|>assistant<\|end_header_id\|>/);
  });

  test('1.2  systemPrompt is injected when no system message exists', () => {
    const prompt = formatChatPrompt(
      [{ role: 'user', content: 'Hi' }],
      'llama3',
      'You are a pirate.'
    );
    expect(prompt).toContain('You are a pirate.');
  });

  test('1.3  multi-turn keeps correct order', () => {
    const msgs: ChatMessage[] = [
      { role: 'user',      content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user',      content: 'Q2' },
    ];
    const prompt = formatChatPrompt(msgs, 'llama3');
    expect(prompt.indexOf('Q1')).toBeLessThan(prompt.indexOf('A1'));
    expect(prompt.indexOf('A1')).toBeLessThan(prompt.indexOf('Q2'));
  });

  test('1.4  mistral format uses [INST]..[/INST]', () => {
    const prompt = formatChatPrompt([{ role: 'user', content: 'Hello' }], 'mistral');
    expect(prompt).toContain('[INST]');
    expect(prompt).toContain('[/INST]');
  });

  test('1.5  chatml uses <|im_start|> tokens', () => {
    const prompt = formatChatPrompt([{ role: 'user', content: 'Hi' }], 'chatml');
    expect(prompt).toContain('<|im_start|>user');
    expect(prompt).toContain('<|im_end|>');
  });

  test('1.6  inferChatTemplate detects llama3 for bitnet models', () => {
    expect(inferChatTemplate('hf://microsoft/bitnet-b1.58-2B-4T-gguf')).toBe('llama3');
  });

  test('1.7  inferChatTemplate detects mistral', () => {
    expect(inferChatTemplate('hf://mistralai/Mistral-7B-Instruct-v0.2')).toBe('mistral');
  });

  test('1.8  inferChatTemplate detects chatml for Qwen', () => {
    expect(inferChatTemplate('hf://Qwen/Qwen2.5-0.5B-Instruct-GGUF')).toBe('chatml');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. InferenceEngine
// ═══════════════════════════════════════════════════════════════════════════

describe('2. InferenceEngine — streaming & concurrency', () => {

  test('2.1  generate() returns full assembled text', async () => {
    const engine = new InferenceEngine();
    const result = await engine.generate('Test prompt');
    expect(result.content).toBe('Hello, world!');
    expect(result.tokenCount).toBe(4);
    engine.dispose();
  });

  test('2.2  generate() calls onToken for every token', async () => {
    const engine = new InferenceEngine();
    const tokens: string[] = [];
    await engine.generate('prompt', {}, t => tokens.push(t));
    expect(tokens).toEqual(['Hello', ',', ' world', '!']);
    engine.dispose();
  });

  test('2.3  generate() uses correct sampling params', async () => {
    const engine = new InferenceEngine();
    await engine.generate('hello', { temperature: 0.3, topK: 10, maxTokens: 50, seed: 7 });
    expect(mockStart).toHaveBeenCalledWith(
      expect.any(String), 'hello',
      0.3, 10, 0.95, 50, 1.1, '[]', 7
    );
    engine.dispose();
  });

  test('2.4  generateStream() yields chunks then done=true', async () => {
    const engine = new InferenceEngine();
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of engine.generateStream('prompt')) {
      chunks.push(chunk);
    }
    expect(chunks.filter(c => !c.done).map(c => c.delta)).toEqual(['Hello', ',', ' world', '!']);
    expect(chunks[chunks.length - 1]!.done).toBe(true);
    engine.dispose();
  });

  test('2.5  throws EngineNotInitializedError when no model loaded', async () => {
    mockLoaded.mockReturnValue(false);
    const engine = new InferenceEngine();
    await expect(engine.generate('p')).rejects.toBeInstanceOf(EngineNotInitializedError);
    engine.dispose();
  });

  test('2.6  throws ConcurrencyLimitError on second concurrent request', async () => {
    const engine = new InferenceEngine(1);
    // First request never finishes on its own during this test
    mockStart.mockImplementationOnce(() => new Promise(() => {}));
    void engine.generate('p1').catch(() => {});
    await new Promise(r => setImmediate(r));
    await expect(engine.generate('p2')).rejects.toBeInstanceOf(ConcurrencyLimitError);
    engine.dispose();
  });

  test('2.7  native error rejects the promise with InferenceError', async () => {
    const engine = new InferenceEngine();
    mockStart.mockImplementation(async (id: string) => {
      setImmediate(() =>
        _handler?.({ requestId: id, error: 'decode failed', tokenCount: 0, done: false })
      );
    });
    await expect(engine.generate('p')).rejects.toBeInstanceOf(InferenceError);
    engine.dispose();
  });

  test('2.8  cancel() calls nativeCancelGeneration', async () => {
    const engine = new InferenceEngine();
    let capturedId = '';
    mockStart.mockImplementation(async (id: string) => {
      capturedId = id;
      // Never resolves on its own
      await new Promise(() => {});
    });
    engine.generate('p').catch(() => {});
    await new Promise(r => setImmediate(r));
    engine.cancel(capturedId);
    expect(mockCancel).toHaveBeenCalledWith(capturedId);
    engine.dispose();
  });

  test('2.9  AbortSignal already aborted throws immediately', async () => {
    const engine = new InferenceEngine();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      engine.generate('p', {}, undefined, ctrl.signal)
    ).rejects.toBeInstanceOf(InferenceError);
    engine.dispose();
  });

  test('2.10  tokenCount() calls native tokenize', async () => {
    const engine = new InferenceEngine();
    const count = await engine.tokenCount('hello world');
    expect(count).toBe(10);
    engine.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. BitNetClient Stage 3 API
// ═══════════════════════════════════════════════════════════════════════════

describe('3. BitNetClient — Stage 3 inference API', () => {

  test('3.1  chat() returns ChatCompletionResult', async () => {
    const client = new BitNetClient();
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Hello, world!');
    expect(result.tokenCount).toBe(4);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.tokensPerSecond).toBe('number');
    client.dispose();
  });

  test('3.2  chat() uses llama3 template for BitNet model', async () => {
    const client = new BitNetClient();
    // Simulate a BitNet model being loaded
    (client as any)._loadedModelId = 'hf://microsoft/bitnet-b1.58-2B-4T-gguf';

    await client.chat([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Count to 3.' },
    ]);

    const prompt: string = mockStart.mock.calls[0][1];
    expect(prompt).toContain('<|begin_of_text|>');
    expect(prompt).toContain('<|start_header_id|>system<|end_header_id|>');
    expect(prompt).toContain('Be concise.');
    client.dispose();
  });

  test('3.3  chat() respects onToken callback in ChatOptions', async () => {
    const client = new BitNetClient();
    const tokens: string[] = [];
    await client.chat(
      [{ role: 'user', content: 'Hello' }],
      { onToken: t => tokens.push(t) }
    );
    expect(tokens).toEqual(['Hello', ',', ' world', '!']);
    client.dispose();
  });

  test('3.4  chatStream() yields ChatCompletionChunks', async () => {
    const client = new BitNetClient();
    const deltas: string[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'Hi' }])) {
      if (!chunk.done) deltas.push(chunk.delta);
    }
    expect(deltas).toEqual(['Hello', ',', ' world', '!']);
    client.dispose();
  });

  test('3.5  generate() works with raw prompt', async () => {
    const client = new BitNetClient();
    const result = await client.generate('Once upon a time');
    expect(result.content).toBe('Hello, world!');
    client.dispose();
  });

  test('3.6  generateStream() streams raw prompt', async () => {
    const client = new BitNetClient();
    const parts: string[] = [];
    for await (const chunk of client.generateStream('prompt')) {
      if (!chunk.done) parts.push(chunk.delta);
    }
    expect(parts.join('')).toBe('Hello, world!');
    client.dispose();
  });

  test('3.7  chat() with AbortSignal cancels generation', async () => {
    const client = new BitNetClient();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      client.chat([{ role: 'user', content: 'Hi' }], { signal: ctrl.signal })
    ).rejects.toBeInstanceOf(InferenceError);
    client.dispose();
  });

  test('3.8  countTokens() returns token count', async () => {
    const client = new BitNetClient();
    const count = await client.countTokens('hello world');
    expect(count).toBe(10);
    client.dispose();
  });

  test('3.9  getDeviceInfo() returns parsed object', () => {
    const client = new BitNetClient();
    const info = client.getDeviceInfo();
    expect(info.cpuCount).toBe(8);
    expect(info.hasNeon).toBe(true);
    expect(info.arch).toBe('arm64');
    client.dispose();
  });

  test('3.10  getBitNetVersion() returns version string', () => {
    const client = new BitNetClient();
    expect(client.getBitNetVersion()).toBe('llama.cpp-b3.0');
    client.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Full Stage 3 integration checklist
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Stage 3 integration checklist', () => {

  test('4.1  SDK exports ChatTemplate functions', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../src/index');
    expect(typeof sdk.formatChatPrompt).toBe('function');
    expect(typeof sdk.inferChatTemplate).toBe('function');
  });

  test('4.2  SDK exports InferenceEngine class', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('../src/index');
    expect(typeof sdk.InferenceEngine).toBe('function');
  });

  test('4.3  SDK exports Stage 3 error classes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EngineNotInitializedError, ConcurrencyLimitError, InferenceError } =
      require('../src/errors');
    const e1 = new EngineNotInitializedError();
    const e2 = new ConcurrencyLimitError(1, 1);
    const e3 = new InferenceError('fail');
    expect(e1.code).toBe('ENGINE_NOT_INITIALIZED');
    expect(e2.code).toBe('CONCURRENCY_LIMIT');
    expect(e3.code).toBe('INFERENCE_FAILED');
  });

  test('4.4  BitNetClient has all Stage 3 methods', () => {
    const client = new BitNetClient();
    expect(typeof client.chat).toBe('function');
    expect(typeof client.chatStream).toBe('function');
    expect(typeof client.generate).toBe('function');
    expect(typeof client.generateStream).toBe('function');
    expect(typeof client.cancelGeneration).toBe('function');
    expect(typeof client.cancelAllGenerations).toBe('function');
    expect(typeof client.countTokens).toBe('function');
    expect(typeof client.getDeviceInfo).toBe('function');
    expect(typeof client.getBitNetVersion).toBe('function');
    client.dispose();
  });

  test('4.5  Full pipeline: format → engine → result', async () => {
    // 1. Format messages into a prompt
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user',   content: 'Say hello.' },
    ];
    const prompt = formatChatPrompt(messages, 'llama3');
    expect(prompt).toContain('You are a helpful assistant.');

    // 2. Run through the InferenceEngine
    const engine = new InferenceEngine();
    const result = await engine.generate(prompt);
    expect(result.content).toBe('Hello, world!');

    // 3. Check metrics
    expect(result.tokenCount).toBe(4);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    engine.dispose();
  });

  test('4.6  BitNetClient.chat() is end-to-end OpenAI-compatible', async () => {
    const client = new BitNetClient();
    // This is the API a developer would actually call
    const result = await client.chat(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user',   content: 'Hello!' },
      ],
      { temperature: 0.7, maxTokens: 256 }
    );
    expect(result).toMatchObject({
      content: expect.any(String),
      tokenCount: expect.any(Number),
      durationMs: expect.any(Number),
      tokensPerSecond: expect.any(Number),
    });
    client.dispose();
  });
});
