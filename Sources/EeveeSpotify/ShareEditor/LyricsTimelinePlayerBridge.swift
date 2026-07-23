import Foundation
import ObjectiveC
import EeveeSpotifyC

struct LyricsTimelinePlayerSnapshot {
    let trackId: String
    let positionMs: Int
    let durationMs: Int
    let isPlaying: Bool
    let canSeek: Bool
    let canPlay: Bool
    let canPause: Bool

    var dictionary: [String: Any] {
        [
            "trackId": trackId,
            "positionMs": positionMs,
            "durationMs": durationMs,
            "isPlaying": isPlaying,
            "canSeek": canSeek,
            "canPlay": canPlay,
            "canPause": canPause
        ]
    }
}

final class LyricsTimelinePlayerBridge {
    static let shared = LyricsTimelinePlayerBridge()

    private let lock = NSLock()
    private var trackId = ""
    private var positionMs = 0
    private var durationMs = 0
    private var isPlaying = false
    private var playbackSpeed = 1.0
    private var capturedAt = ProcessInfo.processInfo.systemUptime
    private var seekSelector: Selector?

    private init() {}

    func capture(player: AnyObject, state: AnyObject) {
        let positionRaw = number(state, key: "position")
        let durationRaw = number(state, key: "duration")
        let speed = number(state, key: "playbackSpeed")
        let playing = bool(state, key: "isPlaying")
        let resolvedTrackID = resolveTrackID(state: state)

        lock.lock()
        if !resolvedTrackID.isEmpty { trackId = resolvedTrackID }
        durationMs = secondsToMilliseconds(durationRaw)
        let normalizedPosition = max(0, secondsToMilliseconds(positionRaw))
        positionMs = durationMs > 0 ? min(normalizedPosition, durationMs) : normalizedPosition
        playbackSpeed = speed > 0 ? speed : 1
        isPlaying = playing
        capturedAt = ProcessInfo.processInfo.systemUptime
        lock.unlock()
    }

    func snapshot() -> LyricsTimelinePlayerSnapshot {
        if !Thread.isMainThread {
            return DispatchQueue.main.sync { snapshot() }
        }
        lock.lock()
        let control = controlPlayer()
        let directPosition = control.map { secondsToMilliseconds(number($0, key: "position")) } ?? 0
        let directDuration = control.map { secondsToMilliseconds(number($0, key: "duration")) } ?? 0
        let elapsedMs = isPlaying ? max(0, ProcessInfo.processInfo.systemUptime - capturedAt) * 1000 * playbackSpeed : 0
        let estimatedPosition = max(0, positionMs + Int(elapsedMs.rounded()))
        let resolvedDuration = control != nil ? directDuration : durationMs
        let resolvedPosition = control != nil ? directPosition : estimatedPosition
        let livePosition = resolvedDuration > 0 ? min(resolvedPosition, resolvedDuration) : resolvedPosition
        let liveTrackID = currentTrackID()
        let hasLiveTrack = !liveTrackID.isEmpty
        let trackId = hasLiveTrack ? liveTrackID : (control == nil ? self.trackId : "")
        if !trackId.isEmpty { self.trackId = trackId }
        let isPlaying = control.flatMap { player in
            optionalBool(player, key: "isPaused").map { !$0 }
        } ?? self.isPlaying
        let seekRestricted = control.flatMap { player -> Bool? in
            guard let disallow = optionalBool(player, key: "disallowSeeking"),
                  let always = optionalBool(player, key: "disallowSeekingAlways") else { return nil }
            return disallow || always
        }
        let canSeek = hasLiveTrack && (control.map {
            resolveSeekSelector(on: $0) != nil && seekRestricted == false
        } ?? false)
        let canSetPaused = hasLiveTrack && (control.map { resolvePausedSelector(on: $0) != nil } ?? false)
        lock.unlock()
        return LyricsTimelinePlayerSnapshot(
            trackId: trackId,
            positionMs: livePosition,
            durationMs: resolvedDuration,
            isPlaying: isPlaying,
            canSeek: canSeek,
            canPlay: canSetPaused,
            canPause: canSetPaused
        )
    }

    @discardableResult
    func seek(positionMs: Int, expectedTrackID: String) -> Bool {
        if !Thread.isMainThread {
            return DispatchQueue.main.sync { seek(positionMs: positionMs, expectedTrackID: expectedTrackID) }
        }
        let liveTrackID = currentTrackID()
        guard liveTrackID == expectedTrackID else { return false }
        lock.lock()
        guard let player = controlPlayer(),
              optionalBool(player, key: "disallowSeeking") == false,
              optionalBool(player, key: "disallowSeekingAlways") == false,
              let selector = resolveSeekSelector(on: player) else {
            lock.unlock()
            return false
        }
        let seconds = Double(max(0, positionMs)) / 1000
        trackId = liveTrackID
        self.positionMs = max(0, positionMs)
        capturedAt = ProcessInfo.processInfo.systemUptime
        lock.unlock()
        EeveeSBInvokeSeekDouble(player, selector, seconds)
        return true
    }

    @discardableResult
    func play(expectedTrackID: String) -> Bool {
        setPaused(false, expectedTrackID: expectedTrackID)
    }

    @discardableResult
    func pause(expectedTrackID: String) -> Bool {
        setPaused(true, expectedTrackID: expectedTrackID)
    }

    private func setPaused(_ paused: Bool, expectedTrackID: String) -> Bool {
        if !Thread.isMainThread {
            return DispatchQueue.main.sync { setPaused(paused, expectedTrackID: expectedTrackID) }
        }
        let liveTrackID = currentTrackID()
        guard liveTrackID == expectedTrackID else { return false }
        lock.lock()
        guard let player = controlPlayer(),
              let selector = resolvePausedSelector(on: player) else {
            lock.unlock()
            return false
        }
        trackId = liveTrackID
        isPlaying = !paused
        capturedAt = ProcessInfo.processInfo.systemUptime
        lock.unlock()
        EeveeInvokeBool(player, selector, paused)
        return true
    }

    private func resolveSeekSelector(on player: AnyObject) -> Selector? {
        if let seekSelector = seekSelector, player.responds(to: seekSelector) { return seekSelector }
        let selector = NSSelectorFromString("seekTo:")
        guard player.responds(to: selector),
              let method = class_getInstanceMethod(object_getClass(player), selector),
              returnType(method) == "v",
              method_getNumberOfArguments(method) == 3,
              argumentType(method, index: 2) == "d" else { return nil }
        seekSelector = selector
        return selector
    }

    private func resolvePausedSelector(on player: AnyObject) -> Selector? {
        let selector = NSSelectorFromString("setIsPaused:")
        guard player.responds(to: selector),
              let method = class_getInstanceMethod(object_getClass(player), selector),
              returnType(method) == "v",
              method_getNumberOfArguments(method) == 3,
              ["B", "c"].contains(argumentType(method, index: 2)) else { return nil }
        return selector
    }

    private func argumentType(_ method: Method, index: UInt32) -> String {
        guard let raw = method_copyArgumentType(method, index) else { return "" }
        defer { free(raw) }
        return String(cString: raw)
    }

    private func returnType(_ method: Method) -> String {
        let raw = method_copyReturnType(method)
        defer { free(raw) }
        return String(cString: raw)
    }

    private func resolveTrackID(state: AnyObject) -> String {
        let stateTrack = safeRead(state, key: "track") as AnyObject?
        for candidate in [
            safeRead(stateTrack, key: "trackIdentifier") as? String,
            safeRead(stateTrack, key: "URI") as? String,
            safeRead(stateTrack, key: "uri") as? String,
            statefulPlayer?.currentTrack()?.trackIdentifier
        ] {
            guard let candidate = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !candidate.isEmpty else { continue }
            if isTrackID(candidate) { return candidate }
            if let id = candidate.components(separatedBy: "spotify:track:").last,
               candidate.contains("spotify:track:"), isTrackID(id) { return id }
            if let marker = candidate.range(of: "/track/") {
                let id = String(candidate[marker.upperBound...]).split(separator: "?").first.map(String.init) ?? ""
                if isTrackID(id) { return id }
            }
        }
        return ""
    }

    private func number(_ object: AnyObject, key: String) -> Double {
        (safeRead(object, key: key) as? NSNumber)?.doubleValue ?? 0
    }

    private func bool(_ object: AnyObject, key: String) -> Bool {
        (safeRead(object, key: key) as? NSNumber)?.boolValue ?? false
    }

    private func optionalBool(_ object: AnyObject, key: String) -> Bool? {
        (safeRead(object, key: key) as? NSNumber)?.boolValue
    }

    private func safeRead(_ object: AnyObject?, key: String) -> Any? {
        guard let object = object else { return nil }
        let selector = NSSelectorFromString(key)
        guard object.responds(to: selector) else { return nil }
        return object.value(forKey: key)
    }

    private func controlPlayer() -> AnyObject? {
        guard let player = statefulPlayer else { return nil }
        return player as AnyObject
    }

    private func currentTrackID() -> String {
        let value = statefulPlayer?.currentTrack()?.trackIdentifier.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return isTrackID(value) ? value : ""
    }

    private func isTrackID(_ value: String) -> Bool {
        value.utf8.count == 22 && value.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57)
                || ($0.value >= 65 && $0.value <= 90)
                || ($0.value >= 97 && $0.value <= 122)
        }
    }

    private func secondsToMilliseconds(_ raw: Double) -> Int {
        guard raw.isFinite, raw >= 0 else { return 0 }
        let value = raw * 1000
        return value.isFinite ? Int(min(value.rounded(), Double(Int.max))) : 0
    }
}
