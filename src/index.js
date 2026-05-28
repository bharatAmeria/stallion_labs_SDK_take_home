/**
 * react-native-bitnet — public API surface
 *
 * Quick-start (5 lines):
 * ```ts
 * import { BitNet } from 'react-native-bitnet';
 * await BitNet.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T');
 * await BitNet.loadModel('hf://microsoft/bitnet-b1.58-2B-4T');
 * const { stream } = BitNet.chatStream([{ role: 'user', content: 'Hello!' }]);
 * for await (const chunk of stream) process.stdout.write(chunk.token);
 * ```
 */
export { BitNetClient, formatChatML } from './BitNetClient';
export { ModelManager } from './ModelManager';
export { ModelCache } from './ModelCache';
export { parseHFUrl, pickBestGguf, resolveModelUrl } from './HuggingFaceResolver';
export { createRNBFAdapter, DownloadCancelledError } from './DownloadAdapter';
export { BitNetError, ConcurrencyLimitError, EngineNotInitializedError, InferenceError, InsufficientStorageError, ModelDownloadError, ModelLoadError, ModelNotFoundError, NativeError, } from './errors';
// Default singleton instance for simple use cases
import { BitNetClient } from './BitNetClient';
export const BitNet = new BitNetClient();
