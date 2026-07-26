#import <Foundation/Foundation.h>
#import <Orion/Orion.h>
#import <objc/message.h>
#import "Tweak.h"

void EeveeSBInvokeSeekDouble(id target, SEL selector, double argument) {
    if (!target || !selector) return;
    typedef void (*SeekFn)(id, SEL, double);
    ((SeekFn)objc_msgSend)(target, selector, argument);
}

void EeveeInvokeBool(id target, SEL selector, BOOL argument) {
    if (!target || !selector) return;
    typedef void (*BoolFn)(id, SEL, BOOL);
    ((BoolFn)objc_msgSend)(target, selector, argument);
}

__attribute__((constructor)) static void MITMLyricsStudioInitialize(void) {
    @autoreleasepool {
        NSLog(@"[MITMLyricsStudio] Initializing");
        orion_init();
    }
}
