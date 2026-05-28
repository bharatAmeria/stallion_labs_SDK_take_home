/**
 * BitNetModule.h — React Native Turbo Module for BitNet (iOS)
 *
 * Mirrors the NativeBitNet.ts spec so both platforms expose an identical JS API.
 * The inference engine wraps bitnet.cpp (llama.cpp) compiled for arm64 (Apple Silicon)
 * and arm64e (older iPhone/iPad) via the .podspec's vendored_libraries + cmake build.
 */

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

NS_ASSUME_NONNULL_BEGIN

@interface BitNetModule : RCTEventEmitter <RCTBridgeModule>

@end

NS_ASSUME_NONNULL_END
