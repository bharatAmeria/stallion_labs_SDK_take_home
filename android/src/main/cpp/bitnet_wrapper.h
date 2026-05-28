#pragma once

#include <functional>
#include <string>
#include <vector>
#include <atomic>
#include <memory>

// Forward declarations from llama.cpp
struct llama_model;
struct llama_context;
struct llama_sampler;

namespace bitnet {

/**
 * Sampling configuration forwarded from JS.
 */
struct SamplerConfig {
  float temperature      = 0.8f;
  int   top_k            = 40;
  float top_p            = 0.95f;
  int   max_tokens       = 512;
  float repetition_penalty = 1.1f;
  int   seed             = -1;
  std::vector<std::string> stop_sequences;
};

/**
 * Per-request context.
 */
struct GenerationRequest {
  std::string request_id;
  std::string prompt;
  SamplerConfig sampler;
  std::atomic<bool> cancelled{false};
};

/**
 * Callbacks delivered on the inference thread.
 * The JNI layer posts these back to the Java event emitter.
 */
struct GenerationCallbacks {
  /** Called for each decoded token. `done=true` on the final call. */
  std::function<void(const std::string& request_id,
                     const std::string& token,
                     bool done,
                     int token_count)> on_token;

  /** Called on any inference error. Generation stops after this. */
  std::function<void(const std::string& request_id,
                     const std::string& error,
                     int native_code)> on_error;
};

// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Thin C++ wrapper around llama.cpp / bitnet.cpp.
 *
 * Thread safety: loadModel / unloadModel must NOT be called concurrently.
 * startGeneration is safe to call from any thread AFTER loadModel completes.
 */
class BitNetEngine {
public:
  BitNetEngine() = default;
  ~BitNetEngine();

  BitNetEngine(const BitNetEngine&) = delete;
  BitNetEngine& operator=(const BitNetEngine&) = delete;

  /**
   * Load a GGUF model file into the engine.
   * @return true on success, false on failure (check getLastError()).
   */
  bool loadModel(const std::string& model_path,
                 int threads,
                 int context_size,
                 int batch_size);

  /** Unload the current model and free all native resources. */
  void unloadModel();

  /** True if a model is loaded and ready. */
  bool isLoaded() const { return model_ != nullptr; }

  /**
   * Run inference synchronously (blocks the calling thread).
   * Tokens are delivered via `callbacks.on_token` as they are decoded.
   * Call request.cancelled.store(true) from another thread to abort.
   */
  void generate(GenerationRequest& request, const GenerationCallbacks& callbacks);

  /**
   * Count the number of tokens in `text` using the loaded tokeniser.
   * Returns -1 if no model is loaded.
   */
  int tokenize(const std::string& text) const;

  /** Returns the last error message (empty if none). */
  const std::string& getLastError() const { return last_error_; }

  /** Returns a JSON object string with device / model info. */
  std::string getDeviceInfo() const;

  /** Returns the llama.cpp version string. */
  static std::string getVersion();

private:
  llama_model*   model_   = nullptr;
  llama_context* ctx_     = nullptr;
  int            n_ctx_   = 0;
  int            n_batch_ = 0;
  std::string    last_error_;

  void _setError(const std::string& msg);
  bool _checkStopped(const std::string& text,
                     const std::vector<std::string>& stops) const;
};

} // namespace bitnet
