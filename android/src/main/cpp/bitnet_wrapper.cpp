#include "bitnet_wrapper.h"

// llama.cpp public C API (BitNet-patched version)
#include "llama.h"
#include "ggml.h"

#include <android/log.h>
#include <sstream>
#include <cstring>
#include <thread>
#include <chrono>

#define LOG_TAG "BitNetWrapper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace bitnet {

// ─── Destructor ───────────────────────────────────────────────────────────────

BitNetEngine::~BitNetEngine() {
  unloadModel();
}

// ─── Model load / unload ──────────────────────────────────────────────────────

bool BitNetEngine::loadModel(const std::string& model_path,
                              int threads,
                              int context_size,
                              int batch_size) {
  if (model_) {
    LOGI("Unloading previous model before loading new one");
    unloadModel();
  }

  LOGI("Loading model: %s  threads=%d  ctx=%d  batch=%d",
       model_path.c_str(), threads, context_size, batch_size);

  llama_backend_init();

  // ── Model params ─────────────────────────────────────────────────────────
  llama_model_params mparams = llama_model_default_params();
  mparams.n_gpu_layers = 0;  // CPU-only for Stage 1; GPU path added in Stage 4

  model_ = llama_load_model_from_file(model_path.c_str(), mparams);
  if (!model_) {
    _setError("llama_load_model_from_file returned null — check path and file integrity");
    return false;
  }

  // ── Context params ────────────────────────────────────────────────────────
  llama_context_params cparams = llama_context_default_params();
  cparams.n_ctx     = static_cast<uint32_t>(context_size);
  cparams.n_batch   = static_cast<uint32_t>(batch_size);
  cparams.n_threads = static_cast<uint32_t>(threads);
  cparams.n_threads_batch = static_cast<uint32_t>(threads);

  ctx_ = llama_new_context_with_model(model_, cparams);
  if (!ctx_) {
    llama_free_model(model_);
    model_ = nullptr;
    _setError("llama_new_context_with_model failed");
    return false;
  }

  n_ctx_   = context_size;
  n_batch_ = batch_size;
  LOGI("Model loaded successfully. n_ctx=%d", n_ctx_);
  return true;
}

void BitNetEngine::unloadModel() {
  if (ctx_) {
    llama_free(ctx_);
    ctx_ = nullptr;
  }
  if (model_) {
    llama_free_model(model_);
    model_ = nullptr;
  }
  LOGI("Model unloaded");
}

// ─── Inference ────────────────────────────────────────────────────────────────

void BitNetEngine::generate(GenerationRequest& request,
                             const GenerationCallbacks& callbacks) {
  if (!model_ || !ctx_) {
    callbacks.on_error(request.request_id, "No model loaded", -1);
    return;
  }

  // FIX 1: llama_context_reset_timings renamed to llama_perf_context_reset
  llama_perf_context_reset(ctx_);

  // ── Tokenise prompt ───────────────────────────────────────────────────────
  const std::string& prompt = request.prompt;
  std::vector<llama_token> tokens_list;
  tokens_list.resize(prompt.size() + 32);

  int n_tokens = llama_tokenize(
      model_,                                        // takes model*, not ctx
      prompt.c_str(),
      static_cast<int32_t>(prompt.size()),
      tokens_list.data(),
      static_cast<int32_t>(tokens_list.size()),
      /*add_special=*/true,
      /*parse_special=*/false
  );

  if (n_tokens < 0) {
    tokens_list.resize(-n_tokens);
    n_tokens = llama_tokenize(
        model_,
        prompt.c_str(),
        static_cast<int32_t>(prompt.size()),
        tokens_list.data(),
        static_cast<int32_t>(tokens_list.size()),
        true, false
    );
  }

  if (n_tokens <= 0) {
    callbacks.on_error(request.request_id, "Tokenization failed", -2);
    return;
  }
  tokens_list.resize(n_tokens);

  LOGI("[%s] Prompt tokens: %d", request.request_id.c_str(), n_tokens);

  // Truncate if over context
  if (n_tokens > n_ctx_ - 4) {
    tokens_list.erase(tokens_list.begin(),
                      tokens_list.begin() + (n_tokens - (n_ctx_ - 4)));
    n_tokens = static_cast<int>(tokens_list.size());
    LOGI("[%s] Prompt truncated to %d tokens", request.request_id.c_str(), n_tokens);
  }

  // ── Prefill ───────────────────────────────────────────────────────────────
  // FIX 2: llama_batch_get_one now requires pos_0 and seq_id arguments
  llama_batch batch = llama_batch_get_one(tokens_list.data(), n_tokens,
                                          /*pos_0=*/0, /*seq_id=*/0);
  if (llama_decode(ctx_, batch) != 0) {
    callbacks.on_error(request.request_id, "llama_decode (prefill) failed", -3);
    return;
  }

  // ── Sampler chain ─────────────────────────────────────────────────────────
  auto& cfg = request.sampler;

  // FIX 3: Get model pointer for vocab queries (llama_vocab type removed)
  const struct llama_model* mdl = llama_get_model(ctx_);

  // FIX 4: llama_sampler_init_penalties now requires 9 arguments
  int32_t     n_vocab = llama_n_vocab(mdl);
  llama_token eos_id  = llama_token_eos(mdl);
  llama_token nl_id   = llama_token_nl(mdl);

  llama_sampler* smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());

  llama_sampler_chain_add(smpl,
      llama_sampler_init_penalties(
          n_vocab,
          eos_id,
          nl_id,
          /*penalty_last_n=*/cfg.max_tokens,
          /*penalty_repeat=*/cfg.repetition_penalty,
          /*penalty_freq=*/0.0f,
          /*penalty_present=*/0.0f,
          /*penalize_nl=*/false,
          /*ignore_eos=*/false
      )
  );

  if (cfg.top_k > 0) {
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(cfg.top_k));
  }
  llama_sampler_chain_add(smpl, llama_sampler_init_top_p(cfg.top_p, 1));
  llama_sampler_chain_add(smpl, llama_sampler_init_temp(cfg.temperature));
  llama_sampler_chain_add(smpl,
      llama_sampler_init_dist(cfg.seed == -1
          ? static_cast<uint32_t>(std::chrono::steady_clock::now()
                .time_since_epoch().count())
          : static_cast<uint32_t>(cfg.seed))
  );

  // ── Token decoding loop ───────────────────────────────────────────────────
  std::string generated_text;
  int token_count = 0;

  // Track context position: prompt consumed positions [0, n_tokens)
  llama_pos cur_pos = static_cast<llama_pos>(n_tokens);

  auto cleanup = [&]() { llama_sampler_free(smpl); };

  for (int i = 0; i < cfg.max_tokens; ++i) {
    if (request.cancelled.load(std::memory_order_relaxed)) {
      LOGI("[%s] Generation cancelled at token %d", request.request_id.c_str(), i);
      callbacks.on_token(request.request_id, "", true, token_count);
      cleanup();
      return;
    }

    llama_token new_token = llama_sampler_sample(smpl, ctx_, -1);
    llama_sampler_accept(smpl, new_token);

    // FIX 5: llama_vocab_is_eog → llama_token_is_eog(model, token)
    if (llama_token_is_eog(mdl, new_token)) {
      callbacks.on_token(request.request_id, "", true, token_count);
      cleanup();
      return;
    }

    // FIX 6: llama_token_to_piece now takes model* not vocab*
    char piece[256] = {};
    int piece_len = llama_token_to_piece(mdl, new_token, piece, sizeof(piece),
                                         /*lstrip=*/0, /*special=*/false);
    if (piece_len < 0) piece_len = 0;
    std::string token_str(piece, static_cast<size_t>(piece_len));

    generated_text += token_str;
    ++token_count;

    if (_checkStopped(generated_text, cfg.stop_sequences)) {
      callbacks.on_token(request.request_id, "", true, token_count);
      cleanup();
      return;
    }

    bool is_last = (i == cfg.max_tokens - 1);
    callbacks.on_token(request.request_id, token_str, is_last, token_count);

    if (is_last) break;

    // FIX 7: Decode next token at correct context position
    // FIX 2 (again): llama_batch_get_one needs pos_0 and seq_id
    llama_batch next_batch = llama_batch_get_one(&new_token, 1,
                                                  cur_pos, /*seq_id=*/0);
    ++cur_pos;

    if (llama_decode(ctx_, next_batch) != 0) {
      callbacks.on_error(request.request_id, "llama_decode (generate) failed", -4);
      cleanup();
      return;
    }
  }

  cleanup();
}

// ─── Tokenise utility ────────────────────────────────────────────────────────

int BitNetEngine::tokenize(const std::string& text) const {
  if (!model_) return -1;

  std::vector<llama_token> buf(text.size() + 32);
  int n = llama_tokenize(
      model_,
      text.c_str(),
      static_cast<int32_t>(text.size()),
      buf.data(),
      static_cast<int32_t>(buf.size()),
      false, false
  );
  return (n < 0) ? -n : n;
}

// ─── Device info ─────────────────────────────────────────────────────────────

std::string BitNetEngine::getDeviceInfo() const {
  std::ostringstream ss;
  int cpu_count = static_cast<int>(std::thread::hardware_concurrency());
  ss << "{"
     << "\"cpuCount\":" << cpu_count << ","
     << "\"modelLoaded\":" << (model_ ? "true" : "false") << ","
     << "\"contextSize\":" << n_ctx_ << ","
#if defined(__aarch64__)
     << "\"arch\":\"arm64\","
     << "\"hasNeon\":true"
#elif defined(__arm__)
     << "\"arch\":\"arm32\","
     << "\"hasNeon\":true"
#else
     << "\"arch\":\"x86_64\","
     << "\"hasNeon\":false"
#endif
     << "}";
  return ss.str();
}

std::string BitNetEngine::getVersion() {
  return std::string("llama.cpp-") + llama_print_system_info();
}

// ─── Private helpers ─────────────────────────────────────────────────────────

void BitNetEngine::_setError(const std::string& msg) {
  last_error_ = msg;
  LOGE("BitNetEngine error: %s", msg.c_str());
}

bool BitNetEngine::_checkStopped(const std::string& text,
                                  const std::vector<std::string>& stops) const {
  for (const auto& stop : stops) {
    if (!stop.empty() && text.size() >= stop.size()) {
      if (text.compare(text.size() - stop.size(), stop.size(), stop) == 0) {
        return true;
      }
    }
  }
  return false;
}

} // namespace bitnet
