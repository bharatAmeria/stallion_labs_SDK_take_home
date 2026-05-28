/**
 * BitNetClient — the high-level JS/TS API for react-native-bitnet.
 *
 * This wraps the low-level Turbo Module (NativeBitNet) with:
 *   • Friendly async/await + AsyncIterator APIs
 *   • Typed error translation
 *   • Chat template formatting
 *   • Concurrency guard
 *   • Cancellation handles
 */
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import NativeBitNet from './NativeBitNet';
import { ConcurrencyLimitError, EngineNotInitializedError, InferenceError, ModelLoadError, NativeError, } from './errors';
import { ModelManager } from './ModelManager';
// ─── BitNetClient ─────────────────────────────────────────────────────────────
export class BitNetClient {
    constructor(config = {}) {
        var _a, _b, _c, _d, _e, _f;
        this.activeRequests = new Map();
        this.tokenSubscription = null;
        this.statsSubscription = null;
        this.requestIdCounter = 0;
        this.config = {
            threads: (_a = config.threads) !== null && _a !== void 0 ? _a : 4,
            contextSize: (_b = config.contextSize) !== null && _b !== void 0 ? _b : 2048,
            batchSize: (_c = config.batchSize) !== null && _c !== void 0 ? _c : 512,
            useGpu: (_d = config.useGpu) !== null && _d !== void 0 ? _d : false,
            maxConcurrency: (_e = config.maxConcurrency) !== null && _e !== void 0 ? _e : 1,
        };
        this.modelManager = new ModelManager();
        // NativeModules fallback for Old Arch during migration
        const nativeModule = (_f = NativeModules.RNBitNet) !== null && _f !== void 0 ? _f : (Platform.OS === 'android' ? NativeModules.BitNetModule : null);
        this.eventEmitter = new NativeEventEmitter(nativeModule);
        this._attachListeners();
    }
    // ── Model management (Stage 2) ─────────────────────────────────────────────
    /**
     * Download a model and cache it on-device.
     *
     * Supports `hf://` HuggingFace URLs (with auto GGUF discovery), `https://`
     * direct download links, and resumes interrupted downloads automatically.
     *
     * @example
     * await client.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-bf16-GGUF', {
     *   onProgress: (p) => console.log(`${(p.progress * 100).toFixed(0)}%`),
     * });
     */
    async downloadModel(modelId, opts = {}) {
        return this.modelManager.downloadModel(modelId, opts);
    }
    /** Cancel a download that is currently in progress. */
    cancelDownload(modelId) {
        this.modelManager.cancelDownload(modelId);
    }
    /** True if the model is fully downloaded and available on disk. */
    async isModelDownloaded(modelId) {
        return this.modelManager.isDownloaded(modelId);
    }
    /**
     * List all models in the local cache (any status).
     */
    async listModels() {
        return this.modelManager.listModels();
    }
    /**
     * Delete a cached model from disk and remove it from the manifest.
     */
    async deleteModel(modelId) {
        return this.modelManager.deleteModel(modelId);
    }
    /**
     * Return total disk usage across all cached models.
     */
    async getStorageInfo() {
        return this.modelManager.getStorageInfo();
    }
    // ── Engine lifecycle ────────────────────────────────────────────────────────
    /**
     * Load a model into the inference engine.
     *
     * Accepts:
     *   • An absolute local path (`/data/...`)
     *   • A model ID (`hf://...`) — resolves to the cached local path
     *
     * @example
     * await client.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-bf16-GGUF');
     * // or:
     * await client.loadModel('/data/user/0/com.myapp/files/bitnet-models/model.gguf');
     */
    async loadModel(modelPathOrId) {
        // If it looks like a model ID rather than a path, resolve via cache
        let localPath = modelPathOrId;
        if (modelPathOrId.startsWith('hf://') || !modelPathOrId.startsWith('/')) {
            const cached = this.modelManager.getLocalPath(modelPathOrId);
            if (!cached) {
                throw new ModelLoadError(modelPathOrId, 'Model is not downloaded. Call downloadModel() first.');
            }
            localPath = cached;
        }
        try {
            await NativeBitNet.loadModel(localPath, this.config.threads, this.config.contextSize, this.config.batchSize);
        }
        catch (e) {
            throw new ModelLoadError(modelPathOrId, _extractMessage(e));
        }
    }
    /** Unload the model and free native memory. */
    async unloadModel() {
        await NativeBitNet.unloadModel();
    }
    /** True if a model is loaded and ready for inference. */
    isModelLoaded() {
        return NativeBitNet.isModelLoaded();
    }
    // ── Text generation ─────────────────────────────────────────────────────────
    /**
     * Generate text from a raw prompt string.
     *
     * Returns an async iterator that yields {@link TokenChunk}s as they arrive.
     * Also returns a {@link GenerationHandle} for cancellation.
     *
     * @example
     * const { stream, handle } = client.generateStream('Once upon a time');
     * for await (const chunk of stream) {
     *   process.stdout.write(chunk.token);
     *   if (chunk.done) break;
     * }
     */
    generateStream(prompt, params = {}) {
        const requestId = this._nextRequestId();
        const handle = {
            id: requestId,
            cancel: () => NativeBitNet.cancelGeneration(requestId),
        };
        const stream = this._streamTokens(requestId, prompt, params);
        return { stream, handle };
    }
    /**
     * Generate text and collect the full result.
     * Simpler API when you don't need token-by-token streaming.
     *
     * @example
     * const result = await client.generate('Tell me a joke', { maxTokens: 128 });
     * console.log(result.text);
     */
    async generate(prompt, params = {}) {
        const requestId = this._nextRequestId();
        return this._runGeneration(requestId, prompt, params);
    }
    // ── Chat API (OpenAI-compatible) ────────────────────────────────────────────
    /**
     * Chat completion with message history.
     * Formats messages using the standard ChatML template.
     *
     * Returns an async iterator — same as `generateStream` but accepts messages.
     *
     * @example
     * const { stream } = client.chatStream([
     *   { role: 'system', content: 'You are a helpful assistant.' },
     *   { role: 'user', content: 'What is 2+2?' },
     * ]);
     * for await (const chunk of stream) {
     *   process.stdout.write(chunk.token);
     * }
     */
    chatStream(messages, params = {}) {
        const prompt = formatChatML(messages);
        return this.generateStream(prompt, params);
    }
    /**
     * Chat completion — collect full response.
     *
     * @example
     * const result = await client.chat([
     *   { role: 'user', content: 'Hello!' }
     * ]);
     * console.log(result.text);
     */
    async chat(messages, params = {}) {
        const prompt = formatChatML(messages);
        return this.generate(prompt, params);
    }
    // ── Utilities ───────────────────────────────────────────────────────────────
    /** Count tokens in a string without running inference. */
    async countTokens(text) {
        return NativeBitNet.tokenize(text);
    }
    /** Returns device capability info (CPU count, RAM, NEON support, etc.) */
    getDeviceInfo() {
        return JSON.parse(NativeBitNet.getDeviceInfo());
    }
    /** Returns the bitnet.cpp version string baked into the native library. */
    getBitNetVersion() {
        return NativeBitNet.getBitNetVersion();
    }
    // ── Cleanup ─────────────────────────────────────────────────────────────────
    /** Detach native event listeners. Call when your component unmounts. */
    dispose() {
        var _a, _b;
        (_a = this.tokenSubscription) === null || _a === void 0 ? void 0 : _a.remove();
        (_b = this.statsSubscription) === null || _b === void 0 ? void 0 : _b.remove();
        this.tokenSubscription = null;
        this.statsSubscription = null;
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    _nextRequestId() {
        return `bitnet_${Date.now()}_${++this.requestIdCounter}`;
    }
    _attachListeners() {
        this.tokenSubscription = this.eventEmitter.addListener('BitNetToken', (event) => {
            // Handled inside async generator — nothing to do here globally
            // This subscription is kept alive so the emitter doesn't warn
            void event;
        });
    }
    _streamTokens(_requestId, prompt, params) {
        return __asyncGenerator(this, arguments, function* _streamTokens_1() {
            if (!NativeBitNet.isModelLoaded()) {
                throw new EngineNotInitializedError();
            }
            if (this.activeRequests.size >= this.config.maxConcurrency) {
                throw new ConcurrencyLimitError(this.activeRequests.size, this.config.maxConcurrency);
            }
            const merged = _mergeParams(params);
            const queue = [];
            let resolveWaiter = null;
            const subscription = this.eventEmitter.addListener('BitNetToken', (event) => {
                if (event.requestId !== _requestId)
                    return;
                if (event.error) {
                    queue.push(event.nativeCode != null
                        ? new NativeError(event.nativeCode, event.error)
                        : new InferenceError(event.error));
                }
                else {
                    queue.push(event);
                }
                resolveWaiter === null || resolveWaiter === void 0 ? void 0 : resolveWaiter();
                resolveWaiter = null;
            });
            try {
                yield __await(NativeBitNet.startGeneration(_requestId, prompt, merged.temperature, merged.topK, merged.topP, merged.maxTokens, merged.repetitionPenalty, JSON.stringify(merged.stopSequences), merged.seed));
                this.activeRequests.set(_requestId, {
                    resolve: () => { },
                    reject: () => { },
                });
                while (true) {
                    while (queue.length > 0) {
                        const item = queue.shift();
                        if (item instanceof Error)
                            throw item;
                        yield yield __await({
                            token: item.token,
                            done: item.done,
                            tokenCount: item.tokenCount,
                        });
                        if (item.done)
                            return yield __await(void 0);
                    }
                    // Wait for next event
                    yield __await(new Promise((r) => {
                        resolveWaiter = r;
                    }));
                }
            }
            finally {
                subscription.remove();
                this.activeRequests.delete(_requestId);
            }
        });
    }
    async _runGeneration(_requestId, prompt, params) {
        var _a, e_1, _b, _c;
        const startMs = Date.now();
        let text = '';
        let tokenCount = 0;
        let stopReason = 'eos';
        const { stream } = this.generateStream(prompt, params);
        try {
            for (var _d = true, stream_1 = __asyncValues(stream), stream_1_1; stream_1_1 = await stream_1.next(), _a = stream_1_1.done, !_a; _d = true) {
                _c = stream_1_1.value;
                _d = false;
                const chunk = _c;
                if (!chunk.done)
                    text += chunk.token;
                tokenCount = chunk.tokenCount;
                if (chunk.done)
                    break;
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (!_d && !_a && (_b = stream_1.return)) await _b.call(stream_1);
            }
            finally { if (e_1) throw e_1.error; }
        }
        const durationMs = Date.now() - startMs;
        return {
            text,
            tokenCount,
            totalTokens: tokenCount,
            durationMs,
            tokensPerSecond: tokenCount / Math.max(durationMs / 1000, 0.001),
            stopReason,
        };
    }
}
// ─── Chat template formatting ─────────────────────────────────────────────────
/**
 * Format messages into ChatML — the template used by most open models.
 * Override this if your model uses a different format (Llama 3, Mistral, etc.)
 */
export function formatChatML(messages) {
    let prompt = '';
    for (const msg of messages) {
        prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
    }
    prompt += '<|im_start|>assistant\n';
    return prompt;
}
// ─── Private utilities ────────────────────────────────────────────────────────
const DEFAULTS = {
    temperature: 0.8,
    topK: 40,
    topP: 0.95,
    maxTokens: 512,
    stopSequences: [],
    repetitionPenalty: 1.1,
    seed: -1,
};
function _mergeParams(p) {
    return Object.assign(Object.assign({}, DEFAULTS), p);
}
function _extractMessage(e) {
    if (e instanceof Error)
        return e.message;
    if (typeof e === 'string')
        return e;
    return 'Unknown error';
}
