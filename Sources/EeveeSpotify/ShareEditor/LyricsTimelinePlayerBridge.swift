import Foundation
import ObjectiveC
#if MITM_LYRICS_STANDALONE
import MITMLyricsStudioC
#else
import EeveeSpotifyC
#endif

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

struct LyricsPlaybackEvent {
    let trackId: String
    let positionMs: Int
    let durationMs: Int
    let isPlaying: Bool
}

final class LyricsTimelinePlayerBridge {
    static let shared = LyricsTimelinePlayerBridge()

    private let lock = NSLock()
    private var trackId = ""
    private var positionMs = 0
    private var durationMs = 0
    private var seekSelector: Selector?
    private var capturedTrack: LyricsShareEditorTrackCandidate?

    private init() {}

    @discardableResult
    func capture(player: AnyObject, state: AnyObject) -> LyricsPlaybackEvent {
        let positionRaw = number(state, key: "position")
        let durationRaw = number(state, key: "duration")
        let hasStateTrack = safeRead(state, key: "track") != nil
        let resolvedTrackID = resolveTrackID(state: state)
        let resolvedTrack = resolveTrackCandidate(state: state, trackID: resolvedTrackID)
        let stateTrackID = resolveStateMusicTrackID(state: state)
        let eventDurationMs = normalizeStateMilliseconds(durationRaw, durationHint: durationRaw)
        let eventPositionMs = min(
            normalizeStateMilliseconds(positionRaw, durationHint: durationRaw),
            eventDurationMs > 0 ? eventDurationMs : Int.max
        )
        let eventIsPlaying = optionalBool(state, key: "isPlaying")
            ?? optionalBool(state, key: "isPaused").map { !$0 }
            ?? false

        lock.lock()
        if !resolvedTrackID.isEmpty {
            trackId = resolvedTrackID
            capturedTrack = resolvedTrack
                ?? LyricsShareEditorTrackCandidate(trackId: resolvedTrackID, title: "", artist: "", album: "")
        } else if hasStateTrack {
            trackId = ""
            capturedTrack = nil
        }
        durationMs = secondsToMilliseconds(durationRaw)
        let normalizedPosition = max(0, secondsToMilliseconds(positionRaw))
        positionMs = durationMs > 0 ? min(normalizedPosition, durationMs) : normalizedPosition
        lock.unlock()
        return LyricsPlaybackEvent(
            trackId: stateTrackID,
            positionMs: max(0, eventPositionMs),
            durationMs: max(0, eventDurationMs),
            isPlaying: eventIsPlaying
        )
    }

    func capturedTrackCandidate() -> LyricsShareEditorTrackCandidate? {
        lock.lock()
        defer { lock.unlock() }
        guard !trackId.isEmpty else { return nil }
        if let capturedTrack = capturedTrack, capturedTrack.trackId == trackId {
            return capturedTrack
        }
        return LyricsShareEditorTrackCandidate(trackId: trackId, title: "", artist: "", album: "")
    }

    func snapshot() -> LyricsTimelinePlayerSnapshot {
        if !Thread.isMainThread {
            return DispatchQueue.main.sync { snapshot() }
        }
        lock.lock()
        let control = controlPlayer()
        let directPlayer = statefulControlPlayer()
        let directPosition = directPlayer.flatMap { optionalNumber($0, key: "position") }
            .map(secondsToMilliseconds)
        let directDuration = directPlayer.flatMap { optionalNumber($0, key: "duration") }
            .map(secondsToMilliseconds)
        let directIsPlaying = directPlayer.flatMap { player in
            optionalBool(player, key: "isPaused").map { !$0 }
        }
        let resolvedDuration = directDuration ?? durationMs
        // The observer supplies a last-known position but not a continuously readable clock. Do
        // not turn a stale `isPlaying` callback into a locally advancing playhead.
        let resolvedPosition = directPosition ?? positionMs
        let livePosition = resolvedDuration > 0 ? min(resolvedPosition, resolvedDuration) : resolvedPosition
        let liveTrackID = currentTrackID()
        let hasLiveTrack = !liveTrackID.isEmpty
        let trackId = hasLiveTrack ? liveTrackID : ""
        if !trackId.isEmpty { self.trackId = trackId }
        // Observer callbacks can be missing or stale after a pause transition. Only expose a
        // playing clock when the verified stateful player can be polled directly.
        let isPlaying = directIsPlaying ?? false
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
        lock.lock()
        let liveTrackID = currentTrackID()
        guard liveTrackID == expectedTrackID else {
            lock.unlock()
            return false
        }
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
        lock.lock()
        let liveTrackID = currentTrackID()
        guard liveTrackID == expectedTrackID else {
            lock.unlock()
            return false
        }
        guard let player = controlPlayer(),
              let selector = resolvePausedSelector(on: player) else {
            lock.unlock()
            return false
        }
        trackId = liveTrackID
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
        let trackURI = safeRead(stateTrack, key: "URI") as AnyObject?
        for candidate in [
            safeRead(trackURI, key: "spt_trackIdentifier") as? String,
            safeRead(stateTrack, key: "trackIdentifier") as? String,
            safeRead(trackURI, key: "trackIdentifier") as? String,
            trackURI as? String,
            trackURI.map { String(describing: $0) },
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

    private func resolveStateMusicTrackID(state: AnyObject) -> String {
        guard let stateTrack = safeRead(state, key: "track") as AnyObject?,
              let trackURI = safeRead(stateTrack, key: "URI") as AnyObject? else { return "" }
        if let identifier = safeRead(trackURI, key: "spt_trackIdentifier") as? String {
            let value = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            if isTrackID(value) { return value }
        }
        let uri: String
        if let value = trackURI as? String {
            uri = value
        } else if let value = trackURI as? URL {
            uri = value.absoluteString
        } else {
            uri = String(describing: trackURI)
        }
        let prefix = "spotify:track:"
        guard uri.hasPrefix(prefix) else { return "" }
        let identifier = String(uri.dropFirst(prefix.count))
        return isTrackID(identifier) ? identifier : ""
    }

    private func resolveTrackCandidate(state: AnyObject, trackID: String) -> LyricsShareEditorTrackCandidate? {
        guard !trackID.isEmpty,
              let stateTrack = safeRead(state, key: "track") as AnyObject? else { return nil }
        let metadata = safeRead(stateTrack, key: "metadata") as? [String: String] ?? [:]
        return LyricsShareEditorTrackCandidate(
            trackId: trackID,
            title: firstNonempty([
                safeRead(stateTrack, key: "trackTitle") as? String,
                safeRead(stateTrack, key: "title") as? String,
                metadataValue(in: metadata, keys: ["title", "track_title", "trackName"])
            ]) ?? "",
            artist: firstNonempty([
                safeRead(stateTrack, key: "artistName") as? String,
                safeRead(stateTrack, key: "artistTitle") as? String,
                safeRead(stateTrack, key: "artist") as? String,
                metadataValue(in: metadata, keys: ["artist", "artist_name", "artistName"])
            ]) ?? "",
            album: firstNonempty([
                safeRead(stateTrack, key: "albumName") as? String,
                safeRead(stateTrack, key: "albumTitle") as? String,
                metadataValue(in: metadata, keys: [
                    "album", "album_name", "album_title", "albumName", "albumTitle", "context_album_name"
                ])
            ]) ?? ""
        )
    }

    private func firstNonempty(_ values: [String?]) -> String? {
        values.lazy.compactMap { value in
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
                return nil
            }
            return value
        }.first
    }

    private func metadataValue(in metadata: [String: String], keys: Set<String>) -> String? {
        let normalizedKeys = Set(keys.map { $0.lowercased() })
        return metadata.first { normalizedKeys.contains($0.key.lowercased()) }?.value
    }

    private func number(_ object: AnyObject, key: String) -> Double {
        (safeRead(object, key: key) as? NSNumber)?.doubleValue ?? 0
    }

    private func optionalNumber(_ object: AnyObject, key: String) -> Double? {
        (safeRead(object, key: key) as? NSNumber)?.doubleValue
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
        statefulControlPlayer()
    }

    private func statefulControlPlayer() -> AnyObject? {
        guard let player = statefulPlayer,
              isTrackID(player.currentTrack()?.trackIdentifier ?? "") else { return nil }
        return player as AnyObject
    }

    private func currentTrackID() -> String {
        let value = statefulPlayer?.currentTrack()?.trackIdentifier.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if isTrackID(value) { return value }
        return ""
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

    private func normalizeStateMilliseconds(_ raw: Double, durationHint: Double) -> Int {
        guard raw.isFinite, raw >= 0 else { return 0 }
        let milliseconds = raw > 10_000 || durationHint > 10_000 ? raw : raw * 1000
        return milliseconds.isFinite ? Int(min(milliseconds.rounded(), Double(Int.max))) : 0
    }
}
