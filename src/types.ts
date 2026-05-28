/**
 * Core TypeScript types for react-native-bitnet SDK.
 *
 * Public API surface — all types exported from the package root.
 */

// ─── Model Management ────────────────────────────────────────────────────────

/** Unique identifier for a model (Hugging Face repo ID or direct HTTPS URL). */
export type ModelId = string;

/** Current download / load state of a model. */
export type ModelStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error';

/** Metadata about a locally cached model. */
export interface ModelInfo {
  /** The identifier passed to {@link downloadModel}. */
  id: ModelId;
  /** Absolute local path to the .gguf file. */
  localPath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Current state of this model. */
  status: ModelStatus;
  /** ISO timestamp when the model was fully downloaded. */
  downloadedAt?: string;
}

/** Progress event emitted during model download. */
export interface DownloadProgress {
  /** Model being downloaded. */
  modelId: ModelId;
  /** Bytes received so far. */
  bytesReceived: number;
  /** Total file size in bytes (-1 if unknown). */
  totalBytes: number;
  /** Fraction complete [0, 1]. -1 if totalBytes is unknown. */
  progress: number;
}

// ─── Inference ───────────────────────────────────────────────────────────────

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Parameters controlling text generation.
 * Mirrors the OpenAI Chat Completion parameters where possible.
 */
export interface GenerationParams {
  /**
   * Sampling temperature [0, 2]. Higher = more random.
   * @default 0.8
   */
  temperature?: number;

  /**
   * Top-k sampling. 0 = disabled.
   * @default 40
   */
  topK?: number;

  /**
   * Nucleus (top-p) sampling [0, 1].
   * @default 0.95
   */
  topP?: number;

  /**
   * Maximum number of tokens to generate.
   * @default 512
   */
  maxTokens?: number;

  /**
   * Sequences that stop generation when encountered.
   * @default []
   */
  stopSequences?: string[];

  /**
   * Penalty applied to repeated tokens [1, 2]. 1 = no penalty.
   * @default 1.1
   */
  repetitionPenalty?: number;

  /**
   * Random seed for reproducible outputs. -1 = random.
   * @default -1
   */
  seed?: number;
}

/** A single streamed token chunk. */
export interface TokenChunk {
  /** The new text fragment. */
  token: string;
  /** Whether this is the final chunk (generation complete). */
  done: boolean;
  /** Total tokens generated so far (including this chunk). */
  tokenCount: number;
}

/** Final result after generation completes. */
export interface GenerationResult {
  /** Full generated text. */
  text: string;
  /** Total tokens generated. */
  tokenCount: number;
  /** Total tokens in prompt + generation combined. */
  totalTokens: number;
  /** Wall-clock milliseconds from first token to last. */
  durationMs: number;
  /** Tokens per second throughput. */
  tokensPerSecond: number;
  /** Reason generation stopped. */
  stopReason: 'stop_sequence' | 'max_tokens' | 'cancelled' | 'eos';
}

// ─── Engine Config ────────────────────────────────────────────────────────────

/** Options passed when initializing the BitNet engine. */
export interface BitNetConfig {
  /**
   * Number of CPU threads to use for inference.
   * @default (device CPU count / 2)
   */
  threads?: number;

  /**
   * Context window size (tokens).
   * @default 2048
   */
  contextSize?: number;

  /**
   * Number of tokens to process in a single batch.
   * @default 512
   */
  batchSize?: number;

  /**
   * Enable GPU acceleration if available (Android GPU, Metal on iOS).
   * @default false
   */
  useGpu?: boolean;

  /**
   * Maximum number of concurrent generation requests.
   * Defaults to 1 (sequential). Set >1 only if your model supports it.
   * @default 1
   */
  maxConcurrency?: number;
}

/**
 * Options for chat / generate calls.
 * Extends GenerationParams with streaming callback and abort support.
 */
export interface ChatOptions extends GenerationParams {
  /**
   * Called after each decoded token during streaming generation.
   * @param token   The new text fragment.
   * @param count   Total tokens generated so far.
   */
  onToken?: (token: string, count: number) => void;

  /**
   * AbortSignal to cancel generation (Web-standard API).
   * @example
   * const controller = new AbortController();
   * client.chat(messages, { signal: controller.signal });
   * controller.abort(); // cancels
   */
  signal?: AbortSignal;

  /**
   * Which chat template to use when formatting messages.
   * @default 'llama3'
   */
  chatTemplate?: ChatTemplateId;

  /**
   * System prompt injected as the first system message if none is present.
   */
  systemPrompt?: string;
}

/**
 * A single streaming chunk from chatStream() / generateStream().
 * Mirrors the OpenAI streaming response shape.
 */
export interface ChatCompletionChunk {
  /** The incremental text delta for this chunk. */
  delta: string;
  /** Whether this is the final chunk (generation complete or cancelled). */
  done: boolean;
  /** Total tokens generated so far. */
  tokenCount: number;
}

/**
 * Final result returned by chat() / generate() (non-streaming).
 * Mirrors the OpenAI ChatCompletion response shape.
 */
export interface ChatCompletionResult {
  /** The complete generated text. */
  content: string;
  /** Total tokens in the generated response. */
  tokenCount: number;
  /** Wall-clock milliseconds from first token to last. */
  durationMs: number;
  /** Tokens per second throughput. */
  tokensPerSecond: number;
  /** Why generation ended. */
  stopReason: 'eos' | 'max_tokens' | 'stop_sequence' | 'cancelled';
}

/** Supported chat template formats. */
export type ChatTemplateId = 'llama3' | 'mistral' | 'chatml' | 'alpaca' | 'none';

/** Parsed device + model capability info returned by getDeviceInfo(). */
export interface DeviceInfo {
  cpuCount: number;
  modelLoaded: boolean;
  contextSize: number;
  arch: string;
  hasNeon: boolean;
}

// ─── Cancellation ────────────────────────────────────────────────────────────

/** Handle returned by streaming generation calls — call .cancel() to abort. */
export interface GenerationHandle {
  /** Unique ID for this generation request. */
  id: string;
  /** Cancel an in-progress generation. Safe to call after completion (no-op). */
  cancel: () => void;
}

// ─── Download ────────────────────────────────────────────────────────────────

/** Options passed to {@link ModelManager.downloadModel}. */
export interface DownloadOptions {
  /**
   * Called periodically with download progress.
   * `progress` is in [0, 1]; -1 when the total size is unknown.
   */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Extra HTTP headers forwarded to every request (e.g. HuggingFace auth token).
   * @example { 'Authorization': 'Bearer hf_...' }
   */
  headers?: Record<string, string>;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Disk usage summary for cached models. */
export interface StorageInfo {
  /** Total bytes used by all cached models. */
  totalBytes: number;
  /** Number of models cached locally. */
  modelCount: number;
  /** Per-model breakdown. */
  models: ModelInfo[];
}
