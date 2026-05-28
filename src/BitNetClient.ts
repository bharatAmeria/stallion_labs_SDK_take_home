/**
 * BitNetClient — the high-level JS/TS API for react-native-bitnet.
 *
 * Provides an OpenAI-compatible interface on top of the native BitNet engine.
 *
 * Quick start (5 lines):
 * ──────────────────────
 *   const client = new BitNetClient();
 *   await client.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
 *   await client.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
 *   const result = await client.chat([{ role: 'user', content: 'Hello!' }]);
 *   console.log(result.content);
 */

import { Platform } from 'react-native';
import NativeBitNet from './NativeBitNet';
import type {
  BitNetConfig,
  ChatCompletionChunk,
  ChatCompletionResult,
  ChatMessage,
  ChatOptions,
  DeviceInfo,
  DownloadOptions,
  GenerationParams,
  ModelInfo,
  StorageInfo,
} from './types';
import { ModelLoadError } from './errors';
import { ModelManager } from './ModelManager';
import { InferenceEngine } from './InferenceEngine';
import { formatChatPrompt, inferChatTemplate } from './ChatTemplate';

// ─── Singleton / factory ──────────────────────────────────────────────────────

let _default: BitNetClient | null = null;

/**
 * Returns the shared default BitNetClient instance.
 * Equivalent to `new BitNetClient()` but reuses a single instance.
 */
export function getBitNetClient(config?: BitNetConfig): BitNetClient {
  if (!_default) _default = new BitNetClient(config);
  return _default;
}

// ─── BitNetClient ─────────────────────────────────────────────────────────────

export class BitNetClient {
  private readonly config: Required<BitNetConfig>;
  private readonly modelManager: ModelManager;
  private readonly engine: InferenceEngine;

  // Track which model is currently loaded (for template inference)
  private _loadedModelId: string | null = null;

  constructor(config: BitNetConfig = {}) {
    this.config = {
      threads:        config.threads        ?? 4,
      contextSize:    config.contextSize    ?? 2048,
      batchSize:      config.batchSize      ?? 512,
      useGpu:         config.useGpu         ?? false,
      maxConcurrency: config.maxConcurrency ?? 1,
    };

    this.modelManager = new ModelManager();
    this.engine = new InferenceEngine(this.config.maxConcurrency);

    // Warn on iOS — Android-only SDK
    if (Platform.OS === 'ios') {
      console.warn('[BitNet] This SDK targets Android only. iOS is not supported.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 2 — Model Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Download a model to on-device storage with live progress.
   *
   * @example
   * await client.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf', {
   *   onProgress: (p) => setProgress(p.progress),
   * });
   */
  async downloadModel(modelId: string, opts: DownloadOptions = {}): Promise<ModelInfo> {
    return this.modelManager.downloadModel(modelId, opts);
  }

  /** Cancel an in-progress download. Safe to call after completion (no-op). */
  cancelDownload(modelId: string): void {
    this.modelManager.cancelDownload(modelId);
  }

  /** Returns true if the model is fully downloaded and present on disk. */
  async isModelDownloaded(modelId: string): Promise<boolean> {
    return this.modelManager.isDownloaded(modelId);
  }

  /** List all models in the local cache (any status). */
  async listModels(): Promise<ModelInfo[]> {
    return this.modelManager.listModels();
  }

  /** Delete a cached model from disk and the manifest. */
  async deleteModel(modelId: string): Promise<void> {
    return this.modelManager.deleteModel(modelId);
  }

  /** Return total disk usage across all cached models. */
  async getStorageInfo(): Promise<StorageInfo> {
    return this.modelManager.getStorageInfo();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 1+3 — Engine lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load a model into the inference engine.
   *
   * Accepts a model ID (`hf://...`) or an absolute local path.
   * If a model ID is given and it is in the local cache, the cached path is used.
   *
   * @example
   * await client.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
   */
  async loadModel(modelPathOrId: string): Promise<void> {
    let localPath = modelPathOrId;

    if (modelPathOrId.startsWith('hf://') || !modelPathOrId.startsWith('/')) {
      const cached = this.modelManager.getLocalPath(modelPathOrId);
      if (!cached) {
        throw new ModelLoadError(
          modelPathOrId,
          'Model is not downloaded. Call downloadModel() first.'
        );
      }
      localPath = cached;
    }

    try {
      await NativeBitNet.loadModel(
        localPath,
        this.config.threads,
        this.config.contextSize,
        this.config.batchSize
      );
      this._loadedModelId = modelPathOrId;
    } catch (e: unknown) {
      throw new ModelLoadError(modelPathOrId, _extractMessage(e));
    }
  }

  /** Unload the model and free native memory. */
  async unloadModel(): Promise<void> {
    this.engine.cancelAll();
    await NativeBitNet.unloadModel();
    this._loadedModelId = null;
  }

  /** True if a model is loaded and ready for inference. */
  isModelLoaded(): boolean {
    return NativeBitNet.isModelLoaded();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 3 — Inference API  (OpenAI-compatible)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Chat completion — waits for the full response.
   *
   * @example
   * const res = await client.chat([
   *   { role: 'system', content: 'You are a helpful assistant.' },
   *   { role: 'user',   content: 'What is 2 + 2?' },
   * ]);
   * console.log(res.content); // "4"
   */
  async chat(
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): Promise<ChatCompletionResult> {
    const prompt = this._formatMessages(messages, opts);
    return this.engine.generate(
      prompt,
      _toGenParams(opts),
      opts.onToken,
      opts.signal
    );
  }

  /**
   * Chat completion — streams tokens as an async iterator.
   *
   * @example
   * for await (const chunk of client.chatStream(messages)) {
   *   process.stdout.write(chunk.delta);
   * }
   */
  chatStream(
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    const prompt = this._formatMessages(messages, opts);
    return this.engine.generateStream(prompt, _toGenParams(opts), opts.signal);
  }

  /**
   * Raw text generation — waits for full response.
   *
   * @example
   * const res = await client.generate('Once upon a time');
   * console.log(res.content);
   */
  async generate(
    prompt: string,
    opts: ChatOptions = {}
  ): Promise<ChatCompletionResult> {
    return this.engine.generate(
      prompt,
      _toGenParams(opts),
      opts.onToken,
      opts.signal
    );
  }

  /**
   * Raw text generation — streams tokens as an async iterator.
   *
   * @example
   * for await (const chunk of client.generateStream('Tell me a joke')) {
   *   process.stdout.write(chunk.delta);
   * }
   */
  generateStream(
    prompt: string,
    opts: ChatOptions = {}
  ): AsyncGenerator<ChatCompletionChunk> {
    return this.engine.generateStream(prompt, _toGenParams(opts), opts.signal);
  }

  /**
   * Cancel an in-progress generation by request ID.
   * Use the requestId from the InferenceEngine, or call the AbortController.
   */
  cancelGeneration(requestId: string): void {
    this.engine.cancel(requestId);
  }

  /** Cancel all in-flight generation requests. */
  cancelAllGenerations(): void {
    this.engine.cancelAll();
  }

  /** Whether any generation is currently running. */
  get isGenerating(): boolean {
    return this.engine.isGenerating;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 3 — Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Count how many tokens a string will consume.
   * Useful for prompt-length budgeting before sending.
   *
   * @example
   * const count = await client.countTokens('Hello, world!');
   */
  async countTokens(text: string): Promise<number> {
    return this.engine.tokenCount(text);
  }

  /**
   * Returns device + engine capability info.
   *
   * @example
   * const info = client.getDeviceInfo();
   * console.log(info.cpuCount, info.hasNeon);
   */
  getDeviceInfo(): DeviceInfo {
    return this.engine.getDeviceInfo();
  }

  /** Returns the bitnet.cpp / llama.cpp version string. */
  getBitNetVersion(): string {
    return this.engine.getBitNetVersion();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  /** Release native event listeners. Call when your component / screen unmounts. */
  dispose(): void {
    this.engine.dispose();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _formatMessages(messages: ChatMessage[], opts: ChatOptions): string {
    // Explicit template > auto-detected from loaded model ID > default llama3
    const template =
      opts.chatTemplate ??
      (this._loadedModelId ? inferChatTemplate(this._loadedModelId) : 'llama3');

    return formatChatPrompt(messages, template, opts.systemPrompt);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _toGenParams(opts: ChatOptions): GenerationParams {
  return {
    temperature:       opts.temperature,
    topK:              opts.topK,
    topP:              opts.topP,
    maxTokens:         opts.maxTokens,
    stopSequences:     opts.stopSequences,
    repetitionPenalty: opts.repetitionPenalty,
    seed:              opts.seed,
  };
}

function _extractMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}
