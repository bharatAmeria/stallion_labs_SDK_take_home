# Stage 1 — Setup & Native Bindings

Complete guide to install prerequisites, build the native library, and verify Stage 1.

---

## 1. Prerequisites

Install all of these before running any build commands.

### macOS / Linux

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18 LTS+ | `brew install node` or https://nodejs.org |
| Watchman | latest | `brew install watchman` |
| JDK 17 | 17+ | `brew install --cask zulu17` |
| Android Studio | Hedgehog+ | https://developer.android.com/studio |
| NDK | r26+ | Android Studio → SDK Manager → SDK Tools → NDK (Side by side) |
| CMake | 3.22+ | Android Studio → SDK Manager → SDK Tools → CMake |
| Git | any | `brew install git` |

### Windows

Use WSL2 (Ubuntu 22.04) and follow the Linux steps above.

---

## 2. Android Studio Configuration

After installing Android Studio:

1. Open **SDK Manager** (Tools → SDK Manager)
2. **SDK Platforms**: check Android 14 (API 34)
3. **SDK Tools**: check:
   - Android SDK Build-Tools 34
   - NDK (Side by side) — version 26.x
   - CMake — version 3.22.x
4. Click **Apply** and wait for downloads

Set environment variables (add to `~/.zshrc` or `~/.bashrc`):
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk          # macOS
# export ANDROID_HOME=$HOME/Android/Sdk                # Linux
export ANDROID_NDK=$ANDROID_HOME/ndk/26.x.xxxx         # adjust version
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

Reload your shell:
```bash
source ~/.zshrc
```

---

## 3. Project Setup

```bash
# Clone / navigate to the SDK
cd react-native-bitnet

# Install JS dependencies
npm install
# or: yarn install

# Verify TypeScript compiles cleanly
npx tsc --noEmit
```

Expected output: **no errors**.

---

## 4. Build the Android Native Library

### Option A — Build via Gradle (recommended)

```bash
cd android
./gradlew assembleDebug
```

This will:
1. Run CMake FetchContent to pull BitNet (microsoft/BitNet) from GitHub — **takes 5–15 min on first run**
2. Compile `bitnet_wrapper.cpp` + `bitnet_jni.cpp` against llama.cpp
3. Link `react_native_bitnet.so` for `arm64-v8a`, `armeabi-v7a`, `x86_64`

### Option B — CMake directly (faster iteration)

```bash
mkdir -p android/.cxx/Debug/arm64-v8a
cd android/.cxx/Debug/arm64-v8a

cmake ../../../ \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-24 \
  -DCMAKE_BUILD_TYPE=Debug \
  -G Ninja

ninja -j$(nproc)
```

---

## 5. Verify the Build

### Check the .so exists
```bash
find android/build -name "*.so" | grep react_native_bitnet
```

Expected output:
```
android/build/intermediates/cxx/Debug/.../arm64-v8a/libreact_native_bitnet.so
android/build/intermediates/cxx/Debug/.../x86_64/libreact_native_bitnet.so
```

### Check exported JNI symbols
```bash
# Requires Android NDK on PATH
$ANDROID_NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-nm \
  -D android/build/intermediates/cxx/Debug/*/arm64-v8a/libreact_native_bitnet.so \
  | grep Java_com_bitnet
```

Expected: you should see all 9 `Java_com_bitnet_BitNetModule_native*` symbols.

### TypeScript check
```bash
npx tsc --noEmit
```

No errors = Stage 1 complete ✅

---

## 6. Smoke Test (no device needed)

Run the unit test that mocks the native module:

```bash
npm test
```

---

## 7. Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `CMake Error: CMAKE_TOOLCHAIN_FILE not set` | NDK path wrong | Set `ANDROID_NDK` env var correctly |
| `FetchContent: git not found` | Git missing | `brew install git` |
| `cannot find llama.h` | Submodule not fetched | Add `GIT_SUBMODULES "3rdparty/llama.cpp"` (already in CMakeLists.txt) |
| `Java_com_bitnet_BitNetModule_nativeLoadModel not found` | Package name mismatch | Ensure Kotlin `package com.bitnet` matches JNI `Java_com_bitnet_*` |
| `UnsatisfiedLinkError` in app | `.so` not packaged | Verify `abiFilters` in `build.gradle` matches device ABI |

---

## ✅ Stage 1 Checklist

- [ ] `npm install` — no errors
- [ ] `npx tsc --noEmit` — no errors
- [ ] `./gradlew assembleDebug` — BUILD SUCCESSFUL
- [ ] `.so` file exists for `arm64-v8a`
- [ ] JNI symbols present in `.so`
- [ ] `npm test` — all tests pass

Once all boxes are checked, tell me and we'll move on to **Stage 2: Model Management**.
