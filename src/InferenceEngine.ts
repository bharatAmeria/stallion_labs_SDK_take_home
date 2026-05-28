/**
 * InferenceEngine — JS-side state machine for streaming inference.
 *
 * Responsibilities
 * ────────────────
 * • Subscribe to the 'BitNetToken' native event emitted by BitNetModule.kt
 * • Route each token event to the correct in-flight request via requestId
 * • Enforce concurrency limit (default: 1 sequential request at a time)
 * • Provide both callback-based and async-iterator streaming APIs
 * • Handle cancellation via AbortSignal or explicit cancel()
 *
 * Architecture
 * ────────────
 * The native layer emits all token events on a single 'BitNetToken' channel:
 *   { requestId, token, done, tokenCount }
 *
 * InferenceEngine fans them out to per-request listeners registered in
 * _pending map. This lets multiple concurrent requests (if maxConcurrency > 1)
 * each receive only their own tokens.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import type { GenerationParams, ChatCompletionResult, ChatCompletionChunk, DeviceInfo } from './types';
import {
  InferenceError,
  EngineNotInitializedError,
  ConcurrencyLimitError,
} from './errors';
import NativeBitNet from './NativeBitNet';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenEvent {
  requestId: string;
  token: string;
  done: boolean;
  tokenCount: number;
  error?: string;
  nativeCode?: number;
}

interface PendingRequest {
  resolve: (result: ChatCompletionResult) => void;
  reject: (err: Error) => void;
  onToken?: (token: string, count: number) => void;
  accumulated: string;
  startTime: number;
  tokenCount: number;
}

// ─── ID generator ─────────────────────────────────────────────────────────────

let _reqCounter = 0;
function nextRequestId(): string {
  return `bn_${Date.now()}_${++_reqCounter}`;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class InferenceEngine {
  private readonly _maxConcurrency: number;
  private readonly _pending = new Map<string, PendingRequest>();
  private _subscription: ReturnType<NativeEventEmitter['addListener']> | null = null;

  constructor(maxConcurrency = 1) {
    this._maxConcurrency = maxConcurrency;
    this._attachListener();
  }

  // ── Listener ──────────────────────────────────────────────────────────────

  private _attachListener(): void {
    try {
      const emitter = new NativeEventEmitter(NativeModules.RNBitNet);
      this._subscription = emitter.addListener('BitNetToken', (event: TokenEvent) => {
        this._handleTokenEvent(event);
      });
    } catch {
      // NativeEventEmitter unavailable in test environment — handled in tests
    }
  }

  private _handleTokenEvent(event: TokenEvent): void {
    const entry = this._pending.get(event.requestId);
    if (!entry) return; // Unknown or already-resolved request

    if (event.error !== undefined) {
      // Native error
      this._pending.delete(event.requestId);
      entry.reject(new InferenceError(event.error));
      return;
    }

    if (!event.done && event.token) {
      entry.accumulated += event.token;
      entry.tokenCount = event.tokenCount;
      entry.onToken?.(event.token, event.tokenCount);
    }

    if (event.done) {
      this._pending.delete(event.requestId);
      const durationMs = Date.now() - entry.startTime;
      entry.resolve({
        content: entry.accumulated,
        tokenCount: entry.tokenCount,
        durationMs,
        tokensPerSecond: durationMs > 0 ? (entry.tokenCount / durationMs) * 1000 : 0,
        stopReason: 'eos',
      });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Run inference and return the full result when complete.
   *
   * @param prompt   Fully formatted prompt string.
   * @param params   Generation parameters.
   * @param onToken  Optional streaming callback called for each token.
   * @param signal   AbortSignal to cancel.
   */
  async generate(
    prompt: string,
    params: GenerationParams = {},
    onToken?: (token: string, count: number) => void,
    signal?: AbortSignal
  ): Promise<ChatCompletionResult> {
    if (!NativeBitNet.isModelLoaded()) {
      throw new EngineNotInitializedError();
    }

    if (this._pending.size >= this._maxConcurrency) {
      throw new ConcurrencyLimitError(this._pending.size, this._maxConcurrency);
    }

    const requestId = nextRequestId();

    // Wire up AbortSignal
    if (signal?.aborted) {
      throw new InferenceError('Generation aborted before start');
    }
    const abortHandler = () => this.cancel(requestId);
    signal?.addEventListener('abort', abortHandler, { once: true });

    const promise = new Promise<ChatCompletionResult>((resolve, reject) => {
      this._pending.set(requestId, {
        resolve,
        reject,
        onToken,
        accumulated: '',
        startTime: Date.now(),
        tokenCount: 0,
      });
    });

    try {
      await NativeBitNet.startGeneration(
        requestId,
        prompt,
        params.temperature  ?? 0.8,
        params.topK         ?? 40,
        params.topP         ?? 0.95,
        params.maxTokens    ?? 512,
        params.repetitionPenalty ?? 1.1,
        JSON.stringify(params.stopSequences ?? []),
        params.seed         ?? -1
      );
    } catch (err) {
      this._pending.delete(requestId);
      signal?.removeEventListener('abort', abortHandler);
      throw new InferenceError(err instanceof Error ? err.message : String(err));
    }

    try {
      return await promise;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }
  }

  /**
   * Async generator — yields one {@link ChatCompletionChunk} per token.
   *
   * @example
   * for await (const chunk of engine.generateStream(prompt)) {
   *   process.stdout.write(chunk.delta);
   * }
   */
  async *generateStream(
    prompt: string,
    params: GenerationParams = {},
    signal?: AbortSignal
  ): AsyncGenerator<ChatCompletionChunk> {
    // Use a token queue + promise/resolve pair for back-pressure
    type QueueItem = ChatCompletionChunk | Error;
    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    let finished = false;

    const enqueue = (item: QueueItem) => {
      queue.push(item);
      notify?.();
      notify = null;
    };

    const waitForItem = (): Promise<void> =>
      new Promise(res => { notify = res; });

    // Run generation with a callback that feeds the queue
    const genPromise = this.generate(
      prompt,
      params,
      (token, tokenCount) => {
        enqueue({ delta: token, done: false, tokenCount });
      },
      signal
    ).then(result => {
      enqueue({ delta: '', done: true, tokenCount: result.tokenCount });
    }).catch(err => {
      enqueue(err instanceof Error ? err : new InferenceError(String(err)));
    }).finally(() => {
      finished = true;
      notify?.();
    });

    // Drain the queue as items arrive
    while (true) {
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item instanceof Error) throw item;
        yield item;
        if (item.done) { await genPromise; return; }
      }
      if (finished) break;
      await waitForItem();
    }

    await genPromise;
  }

  /**
   * Cancel a specific in-flight generation.
   * Safe to call after completion (no-op).
   */
  cancel(requestId: string): void {
    if (this._pending.has(requestId)) {
      NativeBitNet.cancelGeneration(requestId);
      // The native layer will emit a done event which resolves the promise
    }
  }

  /**
   * Cancel ALL in-flight generations.
   */
  cancelAll(): void {
    for (const requestId of this._pending.keys()) {
      this.cancel(requestId);
    }
  }

  /** Whether at least one generation is currently running. */
  get isGenerating(): boolean {
    return this._pending.size > 0;
  }

  /** Number of currently active generation requests. */
  get activeCount(): number {
    return this._pending.size;
  }

  /** Parse the JSON device info string from the native layer. */
  getDeviceInfo(): DeviceInfo {
    try {
      return JSON.parse(NativeBitNet.getDeviceInfo()) as DeviceInfo;
    } catch {
      return { cpuCount: 0, modelLoaded: false, contextSize: 0, arch: 'unknown', hasNeon: false };
    }
  }

  /** Get the llama.cpp version string. */
  getBitNetVersion(): string {
    return NativeBitNet.getBitNetVersion();
  }

  /**
   * Count tokens in a string without running inference.
   * Useful for prompt-length budgeting before sending.
   */
  async tokenCount(text: string): Promise<number> {
    return NativeBitNet.tokenize(text);
  }

  /** Detach native event listener. Call this when the engine is no longer needed. */
  dispose(): void {
    this.cancelAll();
    this._subscription?.remove();
    this._subscription = null;
  }
}
