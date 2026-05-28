package com.bitnet

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * React Native Turbo Module for BitNet inference.
 *
 * The public surface here mirrors NativeBitNet.ts exactly.
 * JNI calls down to the C++ BitNetEngine.
 * Events bubble up via the RN event emitter (BitNetToken / BitNetError).
 */
@ReactModule(name = BitNetModule.NAME)
class BitNetModule(reactContext: ReactApplicationContext) :
    NativeBitNetSpec(reactContext) {

    companion object {
        const val NAME = "RNBitNet"

        init {
            // Load the shared library built by CMake
            System.loadLibrary("react_native_bitnet")
        }
    }

    init {
        // Register this Kotlin object with the JNI layer so C++ can call
        // emitToken / emitError back on us.
        nativeInit()
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun getName(): String = NAME

    // ── Native declarations (implemented in bitnet_jni.cpp) ──────────────────

    private external fun nativeInit()
    private external fun nativeLoadModel(
        modelPath: String,
        threads: Int,
        contextSize: Int,
        batchSize: Int
    ): Boolean
    private external fun nativeUnloadModel()
    private external fun nativeIsModelLoaded(): Boolean
    private external fun nativeStartGeneration(
        requestId: String,
        prompt: String,
        temperature: Float,
        topK: Int,
        topP: Float,
        maxTokens: Int,
        repetitionPenalty: Float,
        stopSequences: String,
        seed: Int
    )
    private external fun nativeCancelGeneration(requestId: String)
    private external fun nativeTokenize(text: String): Int
    private external fun nativeGetDeviceInfo(): String
    private external fun nativeGetVersion(): String
    private external fun nativeGetLastError(): String

    // ── TurboModule spec impl ─────────────────────────────────────────────────

    override fun loadModel(
        modelPath: String,
        threads: Double,
        contextSize: Double,
        batchSize: Double,
        promise: Promise
    ) {
        try {
            val ok = nativeLoadModel(
                modelPath,
                threads.toInt(),
                contextSize.toInt(),
                batchSize.toInt()
            )
            if (ok) {
                promise.resolve(true)
            } else {
                promise.reject("MODEL_LOAD_FAILED", nativeGetLastError())
            }
        } catch (e: Exception) {
            promise.reject("MODEL_LOAD_FAILED", e.message ?: "Unknown error", e)
        }
    }

    override fun unloadModel(promise: Promise) {
        try {
            nativeUnloadModel()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("UNLOAD_FAILED", e.message, e)
        }
    }

    override fun isModelLoaded(): Boolean = nativeIsModelLoaded()

    override fun startGeneration(
        requestId: String,
        prompt: String,
        temperature: Double,
        topK: Double,
        topP: Double,
        maxTokens: Double,
        repetitionPenalty: Double,
        stopSequences: String,
        seed: Double,
        promise: Promise
    ) {
        if (!nativeIsModelLoaded()) {
            promise.reject("ENGINE_NOT_INITIALIZED", "No model is loaded. Call loadModel() first.")
            return
        }
        try {
            nativeStartGeneration(
                requestId,
                prompt,
                temperature.toFloat(),
                topK.toInt(),
                topP.toFloat(),
                maxTokens.toInt(),
                repetitionPenalty.toFloat(),
                stopSequences,
                seed.toInt()
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("GENERATION_START_FAILED", e.message, e)
        }
    }

    override fun cancelGeneration(requestId: String) {
        nativeCancelGeneration(requestId)
    }

    override fun tokenize(text: String, promise: Promise) {
        try {
            val count = nativeTokenize(text)
            promise.resolve(count)
        } catch (e: Exception) {
            promise.reject("TOKENIZE_FAILED", e.message, e)
        }
    }

    override fun getDeviceInfo(): String = nativeGetDeviceInfo()

    override fun getBitNetVersion(): String = nativeGetVersion()

    // ── Event emission (called from C++ / JNI thread) ─────────────────────────

    /**
     * Called by JNI on a background thread whenever a token is generated.
     * Posts a 'BitNetToken' event back to JS.
     */
    @Suppress("unused")  // Called from JNI
    fun emitToken(requestId: String, token: String, done: Boolean, tokenCount: Int) {
        val params = Arguments.createMap().apply {
            putString("requestId", requestId)
            putString("token", token)
            putBoolean("done", done)
            putInt("tokenCount", tokenCount)
        }
        sendEvent("BitNetToken", params)
    }

    /**
     * Called by JNI on a background thread when inference fails.
     */
    @Suppress("unused")  // Called from JNI
    fun emitError(requestId: String, error: String, nativeCode: Int) {
        val params = Arguments.createMap().apply {
            putString("requestId", requestId)
            putString("error", error)
            putInt("nativeCode", nativeCode)
            putBoolean("done", true)
        }
        sendEvent("BitNetToken", params)
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(eventName, params)
    }
}
