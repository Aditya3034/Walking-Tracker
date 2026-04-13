#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift StepCounterModule class to the React Native bridge.
RCT_EXTERN_MODULE(StepCounter, RCTEventEmitter)

RCT_EXTERN_METHOD(startStepCounter)
RCT_EXTERN_METHOD(stopStepCounter)

RCT_EXTERN_METHOD(startBackgroundService:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopBackgroundService:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getBackgroundSteps:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getBackgroundRoute:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
