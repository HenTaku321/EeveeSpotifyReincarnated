import Foundation
import ObjectiveC.runtime
import Orion

struct StandalonePlayerObserverGroup: HookGroup {}
struct StandaloneStatefulPlayerGroup: HookGroup {}

private var standaloneObserverRegistered = false
private let standaloneObserver = MITMLyricsPlayerObserver()

@objc final class MITMLyricsPlayerObserver: NSObject {
    @objc func player(_ player: AnyObject, stateDidChange newState: AnyObject) {
        let event = LyricsTimelinePlayerBridge.shared.capture(player: player, state: newState)
        SongSegmentSkipper.shared.process(event: event, player: player)
    }

    @objc func player(
        _ player: AnyObject,
        stateDidChange newState: AnyObject,
        fromState oldState: AnyObject
    ) {
        let event = LyricsTimelinePlayerBridge.shared.capture(player: player, state: newState)
        SongSegmentSkipper.shared.process(event: event, player: player)
    }

    @objc func player(_ player: AnyObject, didEncounterError error: AnyObject) {}
    @objc func player(_ player: AnyObject, didMoveToRelativeTrack relativeIndex: Int) {}
    @objc func player(_ player: AnyObject, queueDidChange queue: AnyObject) {}
}

class MITMLyricsPlayerServiceHook: ClassHook<NSObject> {
    typealias Group = StandalonePlayerObserverGroup
    static let targetName = "SPTPlayerServiceImplementation"

    func addPlayerObserver(_ observer: AnyObject) {
        orig.addPlayerObserver(observer)
        guard !standaloneObserverRegistered else { return }
        standaloneObserverRegistered = true
        orig.addPlayerObserver(standaloneObserver)
        writeDebugLog("[Player] standalone observer registered")
    }
}

class MITMLyricsStatefulPlayerHook: ClassHook<NSObject> {
    typealias Group = StandaloneStatefulPlayerGroup
    static let targetName = "NowPlaying_PlatformImpl.NowPlayingPlatformSwiftServiceImplementation"

    func provideStatefulPlayerWithFeatureIdentifier(_ identifier: NSString) -> StatefulPlayerImplementation {
        let player = orig.provideStatefulPlayerWithFeatureIdentifier(identifier)
        statefulPlayer = player
        writeDebugLog("[Player] stateful player captured")
        return player
    }
}

private var standaloneObserverHookActivated = false
private var standaloneStatefulPlayerHookActivated = false

@discardableResult
func activateStandalonePlayerHooks() -> Bool {
    if !standaloneObserverHookActivated {
        if let serviceClass = NSClassFromString("SPTPlayerServiceImplementation"),
           class_getInstanceMethod(serviceClass, NSSelectorFromString("addPlayerObserver:")) != nil {
            StandalonePlayerObserverGroup().activate()
            standaloneObserverHookActivated = true
            writeDebugLog("[Player] observer hook activated")
        } else {
            writeDebugLog("[Player] observer hook unavailable")
        }
    }

    if !standaloneStatefulPlayerHookActivated {
        let className = "NowPlaying_PlatformImpl.NowPlayingPlatformSwiftServiceImplementation"
        let selector = NSSelectorFromString("provideStatefulPlayerWithFeatureIdentifier:")
        if let serviceClass = NSClassFromString(className),
           let method = class_getInstanceMethod(serviceClass, selector),
           method_getNumberOfArguments(method) == 3,
           methodReturnType(method) == "@",
           methodArgumentType(method, index: 2) == "@" {
            StandaloneStatefulPlayerGroup().activate()
            standaloneStatefulPlayerHookActivated = true
            writeDebugLog("[Player] stateful player hook activated")
        } else {
            writeDebugLog("[Player] stateful player hook unavailable")
        }
    }

    return standaloneObserverHookActivated && standaloneStatefulPlayerHookActivated
}

private func methodReturnType(_ method: Method) -> String {
    let raw = method_copyReturnType(method)
    defer { free(raw) }
    return String(cString: raw)
}

private func methodArgumentType(_ method: Method, index: UInt32) -> String {
    guard let raw = method_copyArgumentType(method, index) else { return "" }
    defer { free(raw) }
    return String(cString: raw)
}
