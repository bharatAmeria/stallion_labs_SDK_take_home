cmake_minimum_required(VERSION 3.22.1)

project(react_native_bitnet VERSION 0.1.0)

# ─── C++ standard ─────────────────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ─── Build type flags ─────────────────────────────────────────────────────────
if(CMAKE_BUILD_TYPE STREQUAL "Release")
  add_compile_options(-O3 -ffast-math -fomit-frame-pointer)
else()
  add_compile_options(-O0 -g)
endif()

# ─── ARM NEON acceleration ────────────────────────────────────────────────────
# arm64-v8a (AArch64): NEON is always present — -mfpu= does NOT exist on 64-bit.
#   Use -march to enable optional extensions (dotprod, i8mm) on top of baseline.
# armeabi-v7a (AArch32): NEON must be explicitly requested with -mfpu=neon.
if(ANDROID_ABI STREQUAL "arm64-v8a")
  add_compile_options(-march=armv8-a+dotprod)   # i8mm dropped: NDK 30 clang needs +i8mm only on r27+
  add_definitions(-DGGML_USE_NEON=1)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  add_compile_options(-mfpu=neon -mfloat-abi=softfp)
  add_definitions(-DGGML_USE_NEON=1)
endif()

# ─── Fetch BitNet (microsoft/BitNet) ──────────────────────────────────────────
# BitNet ships llama.cpp as a patched submodule. Its ggml CMakeLists expects
# include/bitnet-lut-kernels.h — a file that BitNet's setup_env.py normally
# generates from preset_kernels/. We must copy it BEFORE add_subdirectory runs,
# so we use FetchContent_Populate (clone only) + configure_file + add_subdirectory
# instead of the simpler FetchContent_MakeAvailable.
include(FetchContent)

FetchContent_Declare(
  bitnet
  GIT_REPOSITORY https://github.com/microsoft/BitNet.git
  GIT_TAG        main
  GIT_SHALLOW    TRUE
  GIT_SUBMODULES "3rdparty/llama.cpp"
)

# llama.cpp / BitNet build knobs — keep the footprint small for mobile
set(LLAMA_BUILD_TESTS     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES  OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER    OFF CACHE BOOL "" FORCE)
set(LLAMA_STATIC          ON  CACHE BOOL "" FORCE)
set(GGML_METAL            OFF CACHE BOOL "" FORCE)
set(GGML_CUDA             OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN           OFF CACHE BOOL "" FORCE)

# Step 1: clone (populate) only — do NOT process subdirectory CMakeLists yet
FetchContent_GetProperties(bitnet)
if(NOT bitnet_POPULATED)
  FetchContent_Populate(bitnet)

  # Step 2: install the LUT kernel header that llama.cpp's CMake expects.
  #   - arm64-v8a  → tl2 (uses ARM NEON vtbl — fastest on modern Android)
  #   - everything else → tl1 (portable fallback)
  #
  # We default to "bitnet_b1_58-3B" because it's the best mobile-sized model.
  # Change BITNET_PRESET_MODEL if your deployment targets a different architecture.
  set(BITNET_PRESET_MODEL "bitnet_b1_58-3B")

  if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(BITNET_KERNEL_VARIANT "tl2")
  else()
    set(BITNET_KERNEL_VARIANT "tl1")
  endif()

  set(_kernel_src
    "${bitnet_SOURCE_DIR}/preset_kernels/${BITNET_PRESET_MODEL}/bitnet-lut-kernels-${BITNET_KERNEL_VARIANT}.h")
  set(_kernel_dst
    "${bitnet_SOURCE_DIR}/include/bitnet-lut-kernels.h")

  if(NOT EXISTS "${_kernel_src}")
    message(FATAL_ERROR
      "BitNet preset kernel not found: ${_kernel_src}\n"
      "Available presets: ${bitnet_SOURCE_DIR}/preset_kernels/\n"
      "Set BITNET_PRESET_MODEL to a valid subdirectory name.")
  endif()

  if(NOT EXISTS "${_kernel_dst}")
    configure_file("${_kernel_src}" "${_kernel_dst}" COPYONLY)
    message(STATUS "BitNet: installed ${BITNET_KERNEL_VARIANT} kernel "
                   "(${BITNET_PRESET_MODEL}) → include/bitnet-lut-kernels.h")
  endif()

  # Step 3: NOW process BitNet's CMakeLists (which includes llama.cpp)
  add_subdirectory("${bitnet_SOURCE_DIR}" "${bitnet_BINARY_DIR}")
endif()

# ─── JNI bridge shared library ────────────────────────────────────────────────
add_library(
  react_native_bitnet
  SHARED
  src/main/cpp/bitnet_jni.cpp
  src/main/cpp/bitnet_wrapper.cpp
)

target_include_directories(react_native_bitnet PRIVATE
  src/main/cpp
  ${bitnet_SOURCE_DIR}/3rdparty/llama.cpp/include
  ${bitnet_SOURCE_DIR}/3rdparty/llama.cpp/ggml/include
)

# Link against llama (built by FetchContent above) + Android system libs
target_link_libraries(react_native_bitnet
  llama
  ggml
  android
  log
  ${CMAKE_DL_LIBS}
)

# ─── React Native New Architecture (JSI) ─────────────────────────────────────
# When RN_NEW_ARCH is ON the Gradle build injects the JSI/TurboModule headers.
if(DEFINED RN_NEW_ARCH AND RN_NEW_ARCH)
  target_include_directories(react_native_bitnet PRIVATE
    ${REACT_NATIVE_DIR}/ReactAndroid/src/main/jni/react/turbomodule
    ${REACT_NATIVE_DIR}/ReactCommon
    ${REACT_NATIVE_DIR}/ReactCommon/jsi
  )
  target_compile_definitions(react_native_bitnet PRIVATE RN_NEW_ARCH=1)
endif()
