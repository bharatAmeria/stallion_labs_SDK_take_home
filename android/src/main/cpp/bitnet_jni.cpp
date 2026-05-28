/**
 * JNI bridge between Kotlin (BitNetModule.kt) and the C++ BitNetEngine.
 *
 * Each JNI function name must exactly match the pattern:
 *   Java_<package>_<class>_<method>
 * where dots in the package name are replaced with underscores.
 *
 * The Kotlin module calls these via System.loadLibrary("react_native_bitnet").
 */

#include "bitnet_wrapper.h"

#include <jni.h>
#include <android/log.h>
#include <string>
#include <thread>
#include <memory>
#include <mutex>
#include <unordered_map>

#define LOG_TAG "BitNetJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ─── Singleton engine ─────────────────────────────────────────────────────────

static bitnet::BitNetEngine g_engine;
static std::mutex g_engine_mutex;  // guards loadModel / unloadModel

// ─── Active requests (for cancellation) ──────────────────────────────────────

static std::mutex g_requests_mutex;
static std::unordered_map<
    std::string,
    std::shared_ptr<bitnet::GenerationRequest>
> g_active_requests;

// ─── JVM / event emitter references ──────────────────────────────────────────

static JavaVM* g_jvm = nullptr;
static jobject g_module_ref = nullptr;  // global ref to BitNetModule Kotlin object

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_jvm = vm;
  return JNI_VERSION_1_6;
}

// ─── Helper: JNI env for current thread ──────────────────────────────────────

static JNIEnv* getEnv() {
  JNIEnv* env = nullptr;
  if (g_jvm && g_jvm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) {
    return env;
  }
  // Attach if on a background thread
  if (g_jvm) {
    g_jvm->AttachCurrentThread(&env, nullptr);
  }
  return env;
}

// ─── Helper: call module.emitToken(requestId, token, done, tokenCount) ───────

static void emitToken(const std::string& requestId,
                      const std::string& token,
                      bool done,
                      int tokenCount) {
  JNIEnv* env = getEnv();
  if (!env || !g_module_ref) return;

  jclass cls = env->GetObjectClass(g_module_ref);
  if (!cls) return;

  jmethodID mid = env->GetMethodID(
      cls,
      "emitToken",
      "(Ljava/lang/String;Ljava/lang/String;ZI)V"
  );
  if (!mid) {
    env->DeleteLocalRef(cls);
    return;
  }

  jstring jRequestId = env->NewStringUTF(requestId.c_str());
  jstring jToken     = env->NewStringUTF(token.c_str());

  env->CallVoidMethod(g_module_ref, mid, jRequestId, jToken, (jboolean)done, (jint)tokenCount);

  env->DeleteLocalRef(jRequestId);
  env->DeleteLocalRef(jToken);
  env->DeleteLocalRef(cls);
}

static void emitError(const std::string& requestId,
                      const std::string& error,
                      int nativeCode) {
  JNIEnv* env = getEnv();
  if (!env || !g_module_ref) return;

  jclass cls = env->GetObjectClass(g_module_ref);
  if (!cls) return;

  jmethodID mid = env->GetMethodID(
      cls,
      "emitError",
      "(Ljava/lang/String;Ljava/lang/String;I)V"
  );
  if (!mid) { env->DeleteLocalRef(cls); return; }

  jstring jReqId = env->NewStringUTF(requestId.c_str());
  jstring jErr   = env->NewStringUTF(error.c_str());

  env->CallVoidMethod(g_module_ref, mid, jReqId, jErr, (jint)nativeCode);

  env->DeleteLocalRef(jReqId);
  env->DeleteLocalRef(jErr);
  env->DeleteLocalRef(cls);
}

// ─── JNI exports ─────────────────────────────────────────────────────────────

extern "C" {

/**
 * Called once from BitNetModule.kt to register the Kotlin object so JNI
 * can call back into it for token events.
 */
JNIEXPORT void JNICALL
Java_com_bitnet_BitNetModule_nativeInit(JNIEnv* env, jobject thiz) {
  if (g_module_ref) {
    env->DeleteGlobalRef(g_module_ref);
  }
  g_module_ref = env->NewGlobalRef(thiz);
  LOGI("nativeInit: module reference stored");
}

JNIEXPORT jboolean JNICALL
Java_com_bitnet_BitNetModule_nativeLoadModel(
    JNIEnv* env, jobject,
    jstring modelPath,
    jint threads,
    jint contextSize,
    jint batchSize)
{
  const char* path = env->GetStringUTFChars(modelPath, nullptr);
  std::string pathStr(path);
  env->ReleaseStringUTFChars(modelPath, path);

  std::lock_guard<std::mutex> lock(g_engine_mutex);
  bool ok = g_engine.loadModel(pathStr,
                                static_cast<int>(threads),
                                static_cast<int>(contextSize),
                                static_cast<int>(batchSize));
  return static_cast<jboolean>(ok);
}

JNIEXPORT void JNICALL
Java_com_bitnet_BitNetModule_nativeUnloadModel(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lock(g_engine_mutex);
  g_engine.unloadModel();
}

JNIEXPORT jboolean JNICALL
Java_com_bitnet_BitNetModule_nativeIsModelLoaded(JNIEnv*, jobject) {
  return static_cast<jboolean>(g_engine.isLoaded());
}

JNIEXPORT void JNICALL
Java_com_bitnet_BitNetModule_nativeStartGeneration(
    JNIEnv* env, jobject,
    jstring jRequestId,
    jstring jPrompt,
    jfloat temperature,
    jint topK,
    jfloat topP,
    jint maxTokens,
    jfloat repetitionPenalty,
    jstring jStopSequences,  // JSON array string
    jint seed)
{
  const char* reqId  = env->GetStringUTFChars(jRequestId, nullptr);
  const char* prompt = env->GetStringUTFChars(jPrompt, nullptr);
  const char* stops  = env->GetStringUTFChars(jStopSequences, nullptr);

  auto request = std::make_shared<bitnet::GenerationRequest>();
  request->request_id = reqId;
  request->prompt     = prompt;
  request->sampler.temperature       = temperature;
  request->sampler.top_k             = topK;
  request->sampler.top_p             = topP;
  request->sampler.max_tokens        = maxTokens;
  request->sampler.repetition_penalty = repetitionPenalty;
  request->sampler.seed              = seed;

  // Parse stop sequences from JSON string (simple bracket scan)
  std::string stopsStr(stops);
  // Minimal JSON array parser for string arrays ["a","b"]
  size_t pos = 0;
  while ((pos = stopsStr.find('"', pos)) != std::string::npos) {
    size_t end = stopsStr.find('"', pos + 1);
    if (end == std::string::npos) break;
    request->sampler.stop_sequences.push_back(stopsStr.substr(pos + 1, end - pos - 1));
    pos = end + 1;
  }

  env->ReleaseStringUTFChars(jRequestId, reqId);
  env->ReleaseStringUTFChars(jPrompt, prompt);
  env->ReleaseStringUTFChars(jStopSequences, stops);

  // Register for cancellation
  {
    std::lock_guard<std::mutex> lock(g_requests_mutex);
    g_active_requests[request->request_id] = request;
  }

  // Capture for thread
  std::shared_ptr<bitnet::GenerationRequest> req_copy = request;

  // Run inference on a background thread so we don't block the UI
  std::thread([req_copy]() {
    bitnet::GenerationCallbacks callbacks{
        .on_token = emitToken,
        .on_error = emitError,
    };
    g_engine.generate(*req_copy, callbacks);

    // Clean up
    std::lock_guard<std::mutex> lock(g_requests_mutex);
    g_active_requests.erase(req_copy->request_id);
  }).detach();
}

JNIEXPORT void JNICALL
Java_com_bitnet_BitNetModule_nativeCancelGeneration(
    JNIEnv* env, jobject,
    jstring jRequestId)
{
  const char* reqId = env->GetStringUTFChars(jRequestId, nullptr);
  std::string id(reqId);
  env->ReleaseStringUTFChars(jRequestId, reqId);

  std::lock_guard<std::mutex> lock(g_requests_mutex);
  auto it = g_active_requests.find(id);
  if (it != g_active_requests.end()) {
    it->second->cancelled.store(true, std::memory_order_relaxed);
    LOGI("Cancellation requested for %s", id.c_str());
  }
}

JNIEXPORT jint JNICALL
Java_com_bitnet_BitNetModule_nativeTokenize(
    JNIEnv* env, jobject,
    jstring jText)
{
  const char* text = env->GetStringUTFChars(jText, nullptr);
  int count = g_engine.tokenize(std::string(text));
  env->ReleaseStringUTFChars(jText, text);
  return static_cast<jint>(count);
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitNetModule_nativeGetDeviceInfo(JNIEnv* env, jobject) {
  return env->NewStringUTF(g_engine.getDeviceInfo().c_str());
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitNetModule_nativeGetVersion(JNIEnv* env, jobject) {
  return env->NewStringUTF(bitnet::BitNetEngine::getVersion().c_str());
}

JNIEXPORT jstring JNICALL
Java_com_bitnet_BitNetModule_nativeGetLastError(JNIEnv* env, jobject) {
  return env->NewStringUTF(g_engine.getLastError().c_str());
}

} // extern "C"
