/**
 * Typed error classes for react-native-bitnet.
 *
 * Every error thrown by the SDK is an instance of one of these classes, giving
 * callers a reliable way to handle failure modes without parsing message strings.
 */
/** Base class for all SDK errors. */
export class BitNetError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BitNetError';
        this.code = code;
        // Maintains proper prototype chain in transpiled output
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
// ─── Model Management Errors ─────────────────────────────────────────────────
/**
 * Thrown when a model download fails (network error, invalid URL, etc.).
 *
 * @example
 * try {
 *   await BitNet.downloadModel('HF://...');
 * } catch (e) {
 *   if (e instanceof ModelDownloadError) {
 *     console.error('Download failed:', e.modelId, e.message);
 *   }
 * }
 */
export class ModelDownloadError extends BitNetError {
    constructor(modelId, message) {
        super('MODEL_DOWNLOAD_FAILED', `Model "${modelId}": ${message}`);
        this.name = 'ModelDownloadError';
        this.modelId = modelId;
    }
}
/** Thrown when attempting to use a model that hasn't been downloaded yet. */
export class ModelNotFoundError extends BitNetError {
    constructor(modelId) {
        super('MODEL_NOT_FOUND', `Model "${modelId}" is not cached locally. Call downloadModel() first.`);
        this.name = 'ModelNotFoundError';
        this.modelId = modelId;
    }
}
/** Thrown when a model file is corrupt or incompatible. */
export class ModelLoadError extends BitNetError {
    constructor(modelId, message) {
        super('MODEL_LOAD_FAILED', `Failed to load model "${modelId}": ${message}`);
        this.name = 'ModelLoadError';
        this.modelId = modelId;
    }
}
/** Thrown when disk space is insufficient for a download. */
export class InsufficientStorageError extends BitNetError {
    constructor(requiredBytes, availableBytes) {
        super('INSUFFICIENT_STORAGE', `Need ${formatBytes(requiredBytes)} but only ${formatBytes(availableBytes)} available.`);
        this.name = 'InsufficientStorageError';
        this.requiredBytes = requiredBytes;
        this.availableBytes = availableBytes;
    }
}
// ─── Inference Errors ────────────────────────────────────────────────────────
/** Thrown when an inference request fails at the native layer. */
export class InferenceError extends BitNetError {
    constructor(message) {
        super('INFERENCE_FAILED', message);
        this.name = 'InferenceError';
    }
}
/**
 * Thrown when a new generation is requested while the engine is already at
 * maximum concurrency. Callers should queue or cancel existing requests.
 */
export class ConcurrencyLimitError extends BitNetError {
    constructor(activeRequests, limit) {
        super('CONCURRENCY_LIMIT', `Engine is at max concurrency (${activeRequests}/${limit} active requests). ` +
            `Cancel an existing request or increase maxConcurrency in BitNetConfig.`);
        this.name = 'ConcurrencyLimitError';
        this.activeRequests = activeRequests;
        this.limit = limit;
    }
}
// ─── Engine Errors ───────────────────────────────────────────────────────────
/** Thrown when the native engine is not initialized (forgot to call loadModel). */
export class EngineNotInitializedError extends BitNetError {
    constructor() {
        super('ENGINE_NOT_INITIALIZED', 'No model is loaded. Call BitNet.loadModel(modelId) before generating text.');
        this.name = 'EngineNotInitializedError';
    }
}
/** Thrown for native-layer errors with an opaque code. */
export class NativeError extends BitNetError {
    constructor(nativeCode, message) {
        super(`NATIVE_ERROR_${nativeCode}`, `Native error (${nativeCode}): ${message}`);
        this.name = 'NativeError';
        this.nativeCode = nativeCode;
    }
}
// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
