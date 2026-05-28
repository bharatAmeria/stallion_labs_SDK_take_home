<h1 align="center">
  ⚡ react-native-bitnet
</h1>

<p align="center">
  <strong>Run 1-bit LLMs on-device in React Native — no cloud, no latency, no data leaving the device.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/react-native-bitnet">
    <img src="https://img.shields.io/npm/v/react-native-bitnet?color=7c3aed&style=flat-square" alt="npm version" />
  </a>
  <a href="https://github.com/bharatAmeria/stallion_labs_SDK_take_home/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/bharatAmeria/stallion_labs_SDK_take_home/ci.yml?style=flat-square&label=CI" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey?style=flat-square" alt="platform" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/tests-100%20passing-22c55e?style=flat-square" alt="tests" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [BitNetClient](#bitnetclient)
  - [Model Management](#model-management)
  - [Inference API](#inference-api)
  - [Chat Templates](#chat-templates)
  - [Error Handling](#error-handling)
  - [Types](#types)
- [Example App](#example-app)
- [Android Setup](#android-setup)
- [iOS Setup](#ios-setup)
- [Running Tests](#running-tests)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

`react-native-bitnet` is a production-quality React Native SDK that wraps **[BitNet.cpp](https://github.com/microsoft/BitNet)** — Microsoft's open-source inference framework for **1-bit Large Language Models (LLMs)**. It exposes a clean, OpenAI-compatible TypeScript API so mobile developers can run quantized LLMs like *BitNet b1.58* entirely on-device, with zero network dependency.

The model uses **ternary weight quantization** (−1, 0, +1), enabling fast, low-memory inference on consumer-grade hardware including mid-range Android phones. A 2B-parameter model runs in under 1 GB of RAM.

```ts
// The entire SDK in 5 lines
import { BitNet } from 'react-native-bitnet';

await BitNet.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
await BitNet.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
const result = await BitNet.chat([{ role: 'user', content: 'Hello!' }]);
console.log(result.content); // "Hello! How can I help you today?"
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your React Native App                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│   BitNetClient (TypeScript)                                       │
│   ├── ModelManager       ← download, cache, resume, delete       │
│   ├── InferenceEngine    ← streaming, concurrency, cancellation  │
│   ├── ChatTemplate       ← llama3 / mistral / chatml / alpaca    │
│   └── HuggingFaceResolver ← hf:// URL → HTTPS download URL      │
│                                                                   │
├─────────────────── React Native Bridge ─────────────────────────┤
│                                                                   │
│   NativeBitNet (TurboModule Spec)                                 │
│   ├── Android: BitNetModule.kt  →  bitnet_jni.cpp                │
│   └── iOS:     BitNetModule.mm  →  bitnet_wrapper.cpp            │
│                                                                   │
├─────────────────── Native C++ Layer ────────────────────────────┤
│                                                                   │
│   BitNetEngine (C++17)                                            │
│   └── llama.cpp + BitNet.cpp (Microsoft)                         │
│       ├── ARM NEON SIMD acceleration (Android arm64-v8a)         │
│       ├── Apple Accelerate (iOS arm64)                           │
│       └── GGUF model format (.gguf)                              │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

Token events flow from C++ → JNI/ObjC++ → React Native Event Emitter → JavaScript in real time.

---

## Features

| Feature | Details |
|---|---|
| **Native bindings** | C++ JNI on Android, ObjC++ on iOS — no WASM/JS fallback |
| **ARM NEON acceleration** | `arm64-v8a` with `dotprod` extensions; `armeabi-v7a` NEON fallback |
| **Model download** | Auto-resolve `hf://owner/repo` → HuggingFace API → best `.gguf` file |
| **Resumable downloads** | Survives network drops; resumes from byte offset on retry |
| **Streaming inference** | Token callback + async iterator (`for await`) API |
| **OpenAI-compatible API** | Drop-in replacement for `openai.chat.completions.create()` |
| **Chat templates** | Built-in formatters: `llama3`, `mistral`, `chatml`, `alpaca` |
| **Cancellation** | `AbortController` / `AbortSignal` — cancel mid-generation |
| **Typed errors** | `ModelDownloadError`, `InferenceError`, `ConcurrencyLimitError`, etc. |
| **TypeScript-first** | Full type definitions + JSDoc on every public API |
| **100 unit tests** | All passing, with mock adapters for CI (no device needed) |

---

## Requirements

### Common
| Tool | Minimum Version |
|---|---|
| Node.js | 18 LTS |
| React Native | 0.74+ |
| TypeScript | 5.0+ |

### Android
| Tool | Minimum Version | Install |
|---|---|---|
| Android Studio | Hedgehog (2023.1) | [Download](https://developer.android.com/studio) |
| JDK | 17 | `brew install --cask zulu17` |
| NDK | r26+ | Android Studio → SDK Manager → SDK Tools → NDK |
| CMake | 3.22+ | Android Studio → SDK Manager → SDK Tools → CMake |
| Min SDK | API 24 (Android 7) | — |

### iOS
| Tool | Minimum Version |
|---|---|
| Xcode | 15+ |
| CocoaPods | 1.13+ |
| iOS Deployment Target | 13.4+ |

---

## Installation

```bash
# npm
npm install react-native-bitnet react-native-blob-util

# yarn
yarn add react-native-bitnet react-native-blob-util
```

`react-native-blob-util` provides the file-system and download primitives used by `ModelManager` on both platforms.

### iOS — link native pods

```bash
cd ios && pod install
```

### Android — no extra steps

The native `.so` library is built automatically by the Android Gradle plugin via CMake when you run `./gradlew assembleDebug`.

---

## Quick Start

### 1 — Download and load a model

```ts
import { BitNet } from 'react-native-bitnet';

// Download from HuggingFace (shows progress in console)
await BitNet.downloadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf', {
  onProgress: ({ progress, bytesReceived, totalBytes }) => {
    console.log(`${(progress * 100).toFixed(1)}%`);
  },
});

// Load into the inference engine
await BitNet.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
```

### 2 — Single-turn chat (non-streaming)

```ts
const response = await BitNet.chat([
  { role: 'system',    content: 'You are a helpful assistant.' },
  { role: 'user',      content: 'Explain quantum entanglement simply.' },
]);

console.log(response.content);
// → "Quantum entanglement is..."
console.log(`${response.tokenCount} tokens in ${response.durationMs}ms`);
```

### 3 — Streaming chat (token by token)

```ts
for await (const chunk of BitNet.chatStream(messages)) {
  if (!chunk.done) {
    process.stdout.write(chunk.delta); // print each token as it arrives
  }
}
```

### 4 — Streaming with React state

```tsx
const [reply, setReply] = useState('');

const handleSend = async () => {
  let accumulated = '';
  for await (const chunk of BitNet.chatStream(messages, { maxTokens: 256 })) {
    if (!chunk.done) {
      accumulated += chunk.delta;
      setReply(accumulated);
    }
  }
};
```

### 5 — Cancel generation

```ts
const controller = new AbortController();

// Start generation
const stream = BitNet.chatStream(messages, { signal: controller.signal });

// Cancel after 2 seconds
setTimeout(() => controller.abort(), 2000);

for await (const chunk of stream) {
  console.log(chunk.delta);
}
```

---

## API Reference

### BitNetClient

The main entry point. Import the shared singleton `BitNet` or create your own instance.

```ts
import { BitNet, BitNetClient } from 'react-native-bitnet';

// Shared singleton (recommended for most apps)
BitNet.chat(messages);

// Custom instance (multiple configs)
const client = new BitNetClient({
  threads:        4,       // CPU inference threads
  contextSize:    2048,    // KV-cache context window (tokens)
  batchSize:      512,     // Prefill batch size
  useGpu:         false,   // GPU acceleration (experimental)
  maxConcurrency: 1,       // Max parallel requests
});
```

#### Constructor options — `BitNetConfig`

| Option | Type | Default | Description |
|---|---|---|---|
| `threads` | `number` | `4` | CPU threads for inference |
| `contextSize` | `number` | `2048` | Context window in tokens |
| `batchSize` | `number` | `512` | Prefill batch size |
| `useGpu` | `boolean` | `false` | Enable GPU acceleration |
| `maxConcurrency` | `number` | `1` | Max simultaneous requests |

---

### Model Management

#### `downloadModel(modelId, opts?)`

Download a model to on-device storage. Safe to call multiple times — returns immediately if already cached, and deduplicates concurrent calls.

```ts
const info = await client.downloadModel(
  'hf://microsoft/bitnet-b1.58-2B-4T-gguf',
  {
    onProgress: (p) => console.log(`${(p.progress * 100).toFixed(0)}%`),
    headers: { Authorization: 'Bearer hf_...' }, // optional HF token
  }
);
console.log(info.localPath); // /data/data/.../bitnet-models/model.gguf
```

**Supported model ID formats:**

| Format | Example |
|---|---|
| HuggingFace repo (auto-discover best `.gguf`) | `hf://microsoft/bitnet-b1.58-2B-4T-gguf` |
| HuggingFace repo + specific file | `hf://microsoft/bitnet-b1.58-2B-4T-gguf/ggml-model-i2_s.gguf` |
| Direct HTTPS URL | `https://example.com/model.gguf` |

#### `loadModel(modelPathOrId)`

Load a downloaded model into the native inference engine.

```ts
await client.loadModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
```

#### `unloadModel()`

Unload the current model and free native memory.

```ts
await client.unloadModel();
```

#### `isModelDownloaded(modelId)`

Returns `true` if the model is fully downloaded and the file exists on disk.

```ts
const ready = await client.isModelDownloaded('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
```

#### `listModels()`

Returns metadata for all locally cached models.

```ts
const models = await client.listModels();
models.forEach(m => console.log(m.id, m.sizeBytes, m.status));
```

#### `deleteModel(modelId)`

Delete a model from disk and remove it from the manifest.

```ts
await client.deleteModel('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
```

#### `getStorageInfo()`

Returns total disk usage across all cached models.

```ts
const { totalBytes, modelCount, models } = await client.getStorageInfo();
console.log(`${modelCount} model(s) using ${(totalBytes / 1e9).toFixed(2)} GB`);
```

#### `cancelDownload(modelId)`

Cancel an in-progress download. The partial file is retained for resumption.

```ts
client.cancelDownload('hf://microsoft/bitnet-b1.58-2B-4T-gguf');
```

---

### Inference API

#### `chat(messages, opts?)` — non-streaming

Waits for the full response before resolving.

```ts
const result = await client.chat(
  [
    { role: 'system',    content: 'You are a pirate assistant.' },
    { role: 'user',      content: 'Tell me about treasure.' },
    { role: 'assistant', content: 'Arr, treasure be...' },
    { role: 'user',      content: 'What kind of treasure?' },
  ],
  {
    temperature:       0.8,
    topK:              40,
    topP:              0.95,
    maxTokens:         512,
    repetitionPenalty: 1.1,
    seed:              42,        // for reproducible outputs
    stopSequences:     ['</s>'],
  }
);

console.log(result.content);
console.log(result.tokenCount);       // tokens generated
console.log(result.tokensPerSecond);  // throughput
console.log(result.durationMs);       // wall-clock time
```

#### `chatStream(messages, opts?)` — async generator

Yields one `ChatCompletionChunk` per token.

```ts
for await (const chunk of client.chatStream(messages, { maxTokens: 256 })) {
  if (!chunk.done) {
    process.stdout.write(chunk.delta);   // the new token text
  } else {
    console.log(`\n\nTotal: ${chunk.tokenCount} tokens`);
  }
}
```

#### `generate(prompt, opts?)` / `generateStream(prompt, opts?)`

Raw text completion (no chat template applied).

```ts
// Non-streaming
const result = await client.generate('Once upon a time in a land far away,');

// Streaming
for await (const chunk of client.generateStream('The recipe for sourdough is:')) {
  process.stdout.write(chunk.delta);
}
```

#### Generation options — `ChatOptions`

All `GenerationParams` fields plus:

| Option | Type | Default | Description |
|---|---|---|---|
| `temperature` | `number` | `0.8` | Sampling temperature [0, 2] |
| `topK` | `number` | `40` | Top-k sampling (0 = disabled) |
| `topP` | `number` | `0.95` | Nucleus sampling [0, 1] |
| `maxTokens` | `number` | `512` | Max tokens to generate |
| `stopSequences` | `string[]` | `[]` | Stop on these strings |
| `repetitionPenalty` | `number` | `1.1` | Repeat penalty [1, 2] |
| `seed` | `number` | `-1` | RNG seed (-1 = random) |
| `onToken` | `(token, count) => void` | — | Per-token callback |
| `signal` | `AbortSignal` | — | Cancellation signal |
| `chatTemplate` | `ChatTemplateId` | `'llama3'` | Message format |
| `systemPrompt` | `string` | — | Injected system message |

#### `countTokens(text)`

Count tokens without running inference — useful for prompt budgeting.

```ts
const count = await client.countTokens('Hello, world!');
console.log(count); // 4
```

#### `getDeviceInfo()`

Returns hardware and model capability info.

```ts
const info = client.getDeviceInfo();
// { cpuCount: 8, hasNeon: true, arch: 'arm64-v8a', modelLoaded: true, contextSize: 2048 }
```

---

### Chat Templates

The SDK automatically selects the correct template based on the loaded model ID. You can override it per-call.

| Template ID | Models |
|---|---|
| `llama3` | Meta-Llama-3, BitNet b1.58 (default) |
| `mistral` | Mistral, Mixtral |
| `chatml` | Qwen, Yi, InternLM |
| `alpaca` | Alpaca, WizardLM |
| `none` | Raw prompt pass-through |

```ts
const result = await client.chat(messages, { chatTemplate: 'mistral' });
```

---

### Error Handling

All SDK errors extend `BitNetError` and carry a typed `.code` string.

```ts
import {
  BitNetError,
  ModelDownloadError,
  ModelNotFoundError,
  ModelLoadError,
  InferenceError,
  ConcurrencyLimitError,
  EngineNotInitializedError,
  InsufficientStorageError,
} from 'react-native-bitnet';

try {
  await client.loadModel('hf://my/model');
} catch (e) {
  if (e instanceof ModelLoadError) {
    console.error(`Load failed for "${e.modelId}": ${e.message}`);
  } else if (e instanceof ModelNotFoundError) {
    console.error('Model not downloaded yet — call downloadModel() first');
  } else if (e instanceof InsufficientStorageError) {
    console.error(`Need ${e.requiredBytes} bytes, only ${e.availableBytes} free`);
  }
}
```

| Error Class | Code | When thrown |
|---|---|---|
| `ModelDownloadError` | `MODEL_DOWNLOAD_FAILED` | Network error, bad URL, HTTP error |
| `ModelNotFoundError` | `MODEL_NOT_FOUND` | `loadModel` called before `downloadModel` |
| `ModelLoadError` | `MODEL_LOAD_FAILED` | Corrupt file, incompatible format |
| `InsufficientStorageError` | `INSUFFICIENT_STORAGE` | Not enough disk space |
| `InferenceError` | `INFERENCE_FAILED` | Native inference error |
| `ConcurrencyLimitError` | `CONCURRENCY_LIMIT` | Too many simultaneous requests |
| `EngineNotInitializedError` | `ENGINE_NOT_INITIALIZED` | `chat()` called before `loadModel()` |

---

### Types

Key TypeScript types exported from the package root:

```ts
import type {
  BitNetConfig,
  ChatMessage,          // { role: 'system'|'user'|'assistant', content: string }
  ChatOptions,          // GenerationParams + onToken + signal + chatTemplate
  ChatCompletionResult, // { content, tokenCount, durationMs, tokensPerSecond, stopReason }
  ChatCompletionChunk,  // { delta, done, tokenCount }
  ModelInfo,            // { id, localPath, sizeBytes, status, downloadedAt }
  ModelStatus,          // 'not_downloaded'|'downloading'|'downloaded'|'loading'|'ready'|'error'
  DownloadProgress,     // { modelId, bytesReceived, totalBytes, progress }
  StorageInfo,          // { totalBytes, modelCount, models }
  DeviceInfo,           // { cpuCount, hasNeon, arch, modelLoaded, contextSize }
  GenerationHandle,     // { id, cancel() }
} from 'react-native-bitnet';
```

---

## Example App

A fully working example app is included at `example/`. It demonstrates all three core features:

| Screen | Feature |
|---|---|
| **Home** | Download model with animated progress bar, auto-load into engine |
| **Chat** | Multi-turn streaming chat UI, cancel mid-generation |
| **Models** | List cached models, check disk usage, delete models |

### Run the example app

```bash
# 1. Install dependencies
cd example
npm install --legacy-peer-deps

# 2. Start Metro bundler (keep this running)
npm start

# 3. In a new terminal — build the Android app
npm run android

# 4. (Mac only) Build the iOS app
npm run ios
```

> **First build only:** The React Native Gradle plugin must be pre-compiled once before building:
> ```bash
> cd node_modules/@react-native/gradle-plugin
> ./gradlew :react-native-gradle-plugin:jar --no-daemon
> cd ../../..
> ```

---

## Android Setup

### Prerequisites

1. Install **Android Studio Hedgehog** or later
2. Open **SDK Manager** (Tools → SDK Manager) and install:
   - Android SDK Platform **API 35**
   - **NDK (Side by side)** — version `27.1.12297006`
   - **CMake** — version `3.22.1`
3. Set environment variables (add to `~/.zshrc` or `~/.bashrc`):

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk        # macOS
# export ANDROID_HOME=$HOME/Android/Sdk              # Linux
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

### Building the native library

The SDK's CMake build fetches `microsoft/BitNet` from GitHub and compiles `libreact_native_bitnet.so` for all target ABIs. This happens automatically on first `./gradlew assembleDebug`.

Supported ABIs:

| ABI | CPU | SIMD |
|---|---|---|
| `arm64-v8a` | ARMv8 64-bit | NEON + dotprod |
| `armeabi-v7a` | ARMv7 32-bit | NEON |
| `x86_64` | Intel (emulator) | SSE4 |

### Registering the module in your app

In your `MainApplication.kt`:

```kotlin
import com.bitnet.BitNetPackage

override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(BitNetPackage())
    }
```

---

## iOS Setup

### Prerequisites

- macOS with **Xcode 15+** installed
- **CocoaPods** (`sudo gem install cocoapods`)

### Install pods

```bash
cd ios && pod install
```

### Podspec

The SDK's `.podspec` is already configured to compile `bitnet_wrapper.cpp` for `arm64` and `arm64e` architectures via the `source_files` and `compiler_flags` settings.

### Build for simulator vs device

```bash
# Device (arm64)
npx react-native run-ios --device

# Simulator (x86_64 / arm64)
npx react-native run-ios
```

> **Note:** Inference on simulator uses a CPU-only path without NEON acceleration. For performance benchmarking always test on a real device.

---

## Running Tests

The test suite mocks all native modules and runs entirely in Node.js — no device or emulator required.

```bash
# Unit tests (all 100 pass)
npm test

# With coverage report
npm test -- --coverage

# Integration tests (require a live model + device)
npm run test:integration

# TypeScript type check
npx tsc --noEmit
```

### Test coverage

| Module | Tests |
|---|---|
| `BitNetClient` | Download, load, chat, stream, cancel, errors |
| `InferenceEngine` | Token events, concurrency, AbortSignal |
| `ModelManager` | Download deduplication, resume, delete |
| `ModelCache` | Manifest persistence, corrupt recovery |
| `HuggingFaceResolver` | URL parsing, GGUF auto-selection |
| `ChatTemplate` | All 4 template formats |

---

## Project Structure

```
react-native-bitnet/
├── src/                          # TypeScript source (the public API)
│   ├── index.ts                  # Package entry point — all exports
│   ├── BitNetClient.ts           # High-level OpenAI-compatible client
│   ├── InferenceEngine.ts        # Streaming inference + event routing
│   ├── ModelManager.ts           # Download, resume, delete
│   ├── ModelCache.ts             # Persistent JSON manifest
│   ├── HuggingFaceResolver.ts    # hf:// URL → download URL
│   ├── DownloadAdapter.ts        # Platform download abstraction
│   ├── ChatTemplate.ts           # Prompt formatters
│   ├── NativeBitNet.ts           # TurboModule spec (codegen source)
│   ├── types.ts                  # All public TypeScript types
│   └── errors.ts                 # Typed error classes
│
├── android/                      # Android native module
│   ├── CMakeLists.txt            # Fetches BitNet.cpp, builds .so
│   ├── build.gradle              # AGP library config
│   └── src/main/
│       ├── cpp/
│       │   ├── bitnet_wrapper.h  # C++ engine API
│       │   ├── bitnet_wrapper.cpp # llama.cpp integration
│       │   └── bitnet_jni.cpp    # JNI bridge → Kotlin events
│       └── java/com/bitnet/
│           ├── BitNetModule.kt   # TurboModule implementation
│           ├── BitNetPackage.kt  # ReactPackage registration
│           └── NativeBitNetSpec.kt # Abstract base (mirrors TS spec)
│
├── ios/                          # iOS native module
│   ├── BitNetModule.h            # ObjC header
│   └── BitNetModule.mm           # ObjC++ implementation
│
├── cpp/                          # Shared C++ headers (Android + iOS)
│   ├── bitnet_wrapper.h
│   └── bitnet_wrapper.cpp
│
├── example/                      # Example React Native app
│   ├── src/
│   │   ├── App.tsx               # Navigation setup
│   │   ├── bitnet.ts             # Shared client singleton
│   │   └── screens/
│   │       ├── HomeScreen.tsx    # Download + load UI
│   │       ├── ChatScreen.tsx    # Streaming chat UI
│   │       └── ModelsScreen.tsx  # Model management UI
│   ├── android/                  # Example Android project
│   └── ios/                      # Example iOS project
│
├── __tests__/                    # Unit tests (100 passing)
├── __mocks__/                    # Native module mocks for Jest
├── react-native-bitnet.podspec   # CocoaPods spec
└── package.json
```

---

## Contributing

Contributions are welcome! Please open an issue first to discuss significant changes.

### Development setup

```bash
git clone https://github.com/bharatAmeria/stallion_labs_SDK_take_home.git
cd stallion_labs_SDK_take_home
npm install
npm test        # verify all 100 tests pass
npx tsc --noEmit # verify TypeScript compiles clean
```

### Commit message format

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     new feature
fix:      bug fix
perf:     performance improvement
refactor: code change that neither fixes a bug nor adds a feature
test:     adding or updating tests
docs:     documentation only
chore:    build process or auxiliary tool changes
```

### Pull Request checklist

- [ ] `npm test` passes (100/100)
- [ ] `npx tsc --noEmit` passes (zero errors)
- [ ] New public APIs have JSDoc comments and TypeScript types
- [ ] New error cases use a typed error class from `errors.ts`
- [ ] `CHANGELOG.md` updated (for feature/fix PRs)

---

## Roadmap

- [ ] GPU inference via Android OpenCL / Metal on iOS
- [ ] NPU support (Qualcomm Hexagon, Apple Neural Engine)
- [ ] WebAssembly target for React Native Web
- [ ] Quantization-aware fine-tuning export pipeline
- [ ] Benchmark harness (tokens/sec, memory, battery drain)
- [ ] Streaming to `ReadableStream` (Web Streams API)

---

## License

MIT © 2025 — see [LICENSE](./LICENSE) for details.

Built on top of [microsoft/BitNet](https://github.com/microsoft/BitNet) (MIT) and [ggerganov/llama.cpp](https://github.com/ggerganov/llama.cpp) (MIT).

---

<p align="center">
  Made with ❤️ for on-device AI
</p>
