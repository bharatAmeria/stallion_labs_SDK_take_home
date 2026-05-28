/**
 * react-native-bitnet — public API surface
 *
 * Quick-start (5 lines):
 * ```ts
 * import { BitNet } from 'react-native-bitnet';
 * await BitNet.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
 * await BitNet.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
 * const result = await BitNet.chat([{ role: 'user', content: 'Hello!' }]);
 * console.log(result.content);
 * ```
 */

// ── Stage 1+3 — Client & Engine ───────────────────────────────────────────────
export { BitNetClient, getBitNetClient } from './BitNetClient';
export { InferenceEngine } from './InferenceEngine';

// ── Stage 3 — Chat Template ───────────────────────────────────────────────────
export { formatChatPrompt, inferChatTemplate } from './ChatTemplate';

// ── Stage 2 — Model Management ────────────────────────────────────────────────
export { ModelManager } from './ModelManager';
export { ModelCache } from './ModelCache';
export { parseHFUrl, pickBestGguf, resolveModelUrl } from './HuggingFaceResolver';
export type { ResolvedModel, ParsedHFUrl, ResolveOptions } from './HuggingFaceResolver';
export { createRNBFAdapter, DownloadCancelledError } from './DownloadAdapter';
export type { DownloadAdapter, DownloadFileParams, DownloadTask, FileStat } from './DownloadAdapter';

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  // Config
  BitNetConfig,
  // Stage 2
  ModelId,
  ModelInfo,
  ModelStatus,
  DownloadOptions,
  DownloadProgress,
  StorageInfo,
  // Stage 3 — Generation
  ChatMessage,
  ChatOptions,
  ChatCompletionChunk,
  ChatCompletionResult,
  ChatTemplateId,
  DeviceInfo,
  GenerationParams,
  GenerationResult,
  GenerationHandle,
  TokenChunk,
} from './types';

// ── Errors ────────────────────────────────────────────────────────────────────
export {
  BitNetError,
  ConcurrencyLimitError,
  EngineNotInitializedError,
  InferenceError,
  InsufficientStorageError,
  ModelDownloadError,
  ModelLoadError,
  ModelNotFoundError,
  NativeError,
} from './errors';

// ── Default singleton ─────────────────────────────────────────────────────────
// Import at end to avoid circular dependency issues with ESM
import { BitNetClient } from './BitNetClient';
/** Shared default BitNetClient instance — use for simple apps. */
export const BitNet = new BitNetClient();
