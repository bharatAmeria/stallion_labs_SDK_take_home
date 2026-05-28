/**
 * BitNetModule.mm — React Native Turbo Module for BitNet (iOS)
 *
 * Architecture
 * ────────────
 * JS → RCT Bridge → BitNetModule.mm (ObjC++) → bitnet_wrapper.cpp (C++) → llama.cpp
 *
 * Token events flow back via RCTEventEmitter on a background queue so the
 * main thread is never blocked during inference.
 *
 * NOTE: This file is .mm (ObjC++) so it can #include C++ headers directly.
 */

#import "BitNetModule.h"
#import "../cpp/bitnet_wrapper.h"

#include <thread>
#include <string>

using namespace bitnet;

// One shared engine instance per process
static BitNetEngine* gEngine = nil;
static std::unique_ptr<bitnet::BitNetEngine> sCppEngine;

@implementation BitNetModule {
  // Map from requestId -> cancelled flag (we store raw pointers managed by the C++ layer)
  NSMutableDictionary<NSString *, NSValue *> *_pendingRequests;
  dispatch_queue_t _inferenceQueue;
}

RCT_EXPORT_MODULE(RNBitNet)

- (instancetype)init {
  if (self = [super init]) {
    _pendingRequests = [NSMutableDictionary new];
    _inferenceQueue  = dispatch_queue_create("com.bitnet.inference", DISPATCH_QUEUE_SERIAL);
    if (!sCppEngine) {
      sCppEngine = std::make_unique<bitnet::BitNetEngine>();
    }
  }
  return self;
}

// ── Event support ─────────────────────────────────────────────────────────────

- (NSArray<NSString *> *)supportedEvents {
  return @[@"BitNetToken"];
}

- (void)emitToken:(NSString *)requestId
            token:(NSString *)token
             done:(BOOL)done
       tokenCount:(int)tokenCount {
  [self sendEventWithName:@"BitNetToken" body:@{
    @"requestId":   requestId,
    @"token":       token,
    @"done":        @(done),
    @"tokenCount":  @(tokenCount),
  }];
}

- (void)emitError:(NSString *)requestId
            error:(NSString *)error
       nativeCode:(int)nativeCode {
  [self sendEventWithName:@"BitNetToken" body:@{
    @"requestId":  requestId,
    @"error":      error,
    @"nativeCode": @(nativeCode),
    @"done":       @YES,
  }];
}

// ── Model loading ─────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD(loadModel:(NSString *)modelPath
                   threads:(double)threads
               contextSize:(double)contextSize
                 batchSize:(double)batchSize
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_inferenceQueue, ^{
    bool ok = sCppEngine->loadModel(
      modelPath.UTF8String,
      (int)threads,
      (int)contextSize,
      (int)batchSize
    );
    if (ok) {
      resolve(@YES);
    } else {
      NSString *err = [NSString stringWithUTF8String:sCppEngine->getLastError().c_str()];
      reject(@"MODEL_LOAD_FAILED", err, nil);
    }
  });
}

RCT_EXPORT_METHOD(unloadModel:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_inferenceQueue, ^{
    sCppEngine->unloadModel();
    resolve(nil);
  });
}

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSNumber *, isModelLoaded) {
  return @(sCppEngine->isLoaded());
}

// ── Inference ─────────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD(startGeneration:(NSString *)requestId
                         prompt:(NSString *)prompt
                    temperature:(double)temperature
                           topK:(double)topK
                           topP:(double)topP
                      maxTokens:(double)maxTokens
              repetitionPenalty:(double)repetitionPenalty
                  stopSequences:(NSString *)stopSequencesJson
                           seed:(double)seed
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject) {
  // Parse stop sequences from JSON string
  NSArray *stopArr = @[];
  NSData *jsonData = [stopSequencesJson dataUsingEncoding:NSUTF8StringEncoding];
  if (jsonData) {
    stopArr = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil] ?: @[];
  }

  // Build request
  auto request = std::make_shared<bitnet::GenerationRequest>();
  request->request_id = requestId.UTF8String;
  request->prompt     = prompt.UTF8String;
  request->sampler.temperature       = (float)temperature;
  request->sampler.top_k             = (int)topK;
  request->sampler.top_p             = (float)topP;
  request->sampler.max_tokens        = (int)maxTokens;
  request->sampler.repetition_penalty = (float)repetitionPenalty;
  request->sampler.seed              = (int)seed;
  for (NSString *s in stopArr) {
    request->sampler.stop_sequences.push_back(s.UTF8String);
  }

  // Store so we can cancel it
  @synchronized(self) {
    _pendingRequests[requestId] = [NSValue valueWithPointer:request.get()];
  }

  // Return to JS immediately — tokens arrive via events
  resolve(nil);

  // Run inference on the serial queue (blocks until done or cancelled)
  __weak typeof(self) weakSelf = self;
  dispatch_async(_inferenceQueue, ^{
    bitnet::GenerationCallbacks callbacks;
    callbacks.on_token = [weakSelf, requestId](const std::string& rid,
                                                const std::string& token,
                                                bool done,
                                                int count) {
      [weakSelf emitToken:[NSString stringWithUTF8String:rid.c_str()]
                    token:[NSString stringWithUTF8String:token.c_str()]
                     done:done
               tokenCount:count];
    };
    callbacks.on_error = [weakSelf](const std::string& rid,
                                     const std::string& err,
                                     int code) {
      [weakSelf emitError:[NSString stringWithUTF8String:rid.c_str()]
                    error:[NSString stringWithUTF8String:err.c_str()]
               nativeCode:code];
    };

    sCppEngine->generate(*request, callbacks);

    @synchronized(weakSelf) {
      [weakSelf->_pendingRequests removeObjectForKey:requestId];
    }
  });
}

RCT_EXPORT_METHOD(cancelGeneration:(NSString *)requestId) {
  @synchronized(self) {
    NSValue *val = _pendingRequests[requestId];
    if (val) {
      auto *req = static_cast<bitnet::GenerationRequest *>(val.pointerValue);
      req->cancelled.store(true);
    }
  }
}

// ── Tokeniser ─────────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD(tokenize:(NSString *)text
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(_inferenceQueue, ^{
    int count = sCppEngine->tokenize(text.UTF8String);
    resolve(@(count));
  });
}

// ── System info ───────────────────────────────────────────────────────────────

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSString *, getDeviceInfo) {
  return [NSString stringWithUTF8String:sCppEngine->getDeviceInfo().c_str()];
}

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSString *, getBitNetVersion) {
  return [NSString stringWithUTF8String:bitnet::BitNetEngine::getVersion().c_str()];
}

// ── RCTEventEmitter override — don't crash when no listeners ─────────────────

- (void)startObserving {}
- (void)stopObserving  {}

@end
