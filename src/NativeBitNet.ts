/**
 * Turbo Module spec for react-native-bitnet.
 *
 * This file is the codegen source of truth. React Native's codegen reads it to
 * generate the native C++ / Java / ObjC bridge glue automatically at build time.
 *
 * ⚠️  Only use types supported by React Native codegen here (no generics, no
 * union types in function signatures). Keep this file strictly to the native
 * boundary — JS-friendly wrappers live in BitNetClient.ts.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// ─── Codegen-compatible types ─────────────────────────────────────────────────
// (React Native codegen only supports primitives, Object, string[], number[])

export interface Spec extends TurboModule {
  // ── Engine lifecycle ──────────────────────────────────────────────────────

  /**
   * Load a model file into the inference engine.
   *
   * @param modelPath  Absolute local path to the .gguf model file.
   * @param threads    Number of CPU inference threads.
   * @param contextSize  KV-cache context window (tokens).
   * @param batchSize  Tokens per prefill batch.
   * @returns Promise resolving to true on success.
   */
  loadModel(
    modelPath: string,
    threads: number,
    contextSize: number,
    batchSize: number
  ): Promise<boolean>;

  /**
   * Unload the current model and free native memory.
   */
  unloadModel(): Promise<void>;

  /**
   * Returns true if a model is currently loaded and ready.
   */
  isModelLoaded(): boolean;

  // ── Inference ─────────────────────────────────────────────────────────────

  /**
   * Start a streaming text generation.
   *
   * Tokens are delivered via the 'BitNetToken' native event.
   * Completion is signalled by a token event with `done: true`.
   *
   * @param requestId  Caller-supplied unique ID for this request.
   * @param prompt     Fully-formatted prompt string.
   * @param temperature  Sampling temperature.
   * @param topK       Top-k value (0 = disabled).
   * @param topP       Nucleus sampling threshold.
   * @param maxTokens  Maximum tokens to generate.
   * @param repetitionPenalty  Repetition penalty [1, 2].
   * @param stopSequences  JSON-encoded string array of stop sequences.
   * @param seed       RNG seed (-1 = random).
   * @returns Promise resolving when generation starts (not when it finishes).
   */
  startGeneration(
    requestId: string,
    prompt: string,
    temperature: number,
    topK: number,
    topP: number,
    maxTokens: number,
    repetitionPenalty: number,
    stopSequences: string,
    seed: number
  ): Promise<void>;

  /**
   * Cancel an in-progress generation identified by `requestId`.
   * Safe to call even if the request has already finished (no-op).
   */
  cancelGeneration(requestId: string): void;

  // ── Tokeniser utilities ───────────────────────────────────────────────────

  /**
   * Count the number of tokens in a string (without running inference).
   * Useful for prompt-length budgeting.
   */
  tokenize(text: string): Promise<number>;

  // ── System info ───────────────────────────────────────────────────────────

  /**
   * Returns a JSON string with device capability info:
   * { cpuCount, totalRamMb, supportedAbis, hasNeon }
   */
  getDeviceInfo(): string;

  /**
   * Returns the bitnet.cpp version string baked into the native library.
   */
  getBitNetVersion(): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNBitNet');
