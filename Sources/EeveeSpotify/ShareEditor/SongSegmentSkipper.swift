import Foundation
import ObjectiveC

struct SongSegmentRule: Decodable, Equatable {
    let id: String
    let startMs: Int
    let endMs: Int
    let category: String
    let label: String?
    let enabled: Bool
}

struct SongSegmentRulesDocument: Decodable {
    let version: Int
    let trackId: String
    let revision: Int
    let rules: [SongSegmentRule]
}

private struct SongSegmentRulesResponse: Decodable {
    let ok: Bool
    let document: SongSegmentRulesDocument?
}

struct SongSegmentPlaybackSample {
    let trackId: String
    let positionMs: Int
    let durationMs: Int
    let isPlaying: Bool
    let nowMs: Int64
}

struct SongSegmentSkipAction: Equatable {
    let trackId: String
    let positionMs: Int
    let ruleId: String
    let category: String
}

struct SongSegmentStateMachine {
    private static let manualSeekThresholdMs = 2_500
    private static let minimumRemainingMs = 500
    private static let seekCooldownMs: Int64 = 1_500
    private static let seekTargetToleranceMs = 750

    private var document: SongSegmentRulesDocument?
    private var playbackTrackId = ""
    private var lastPositionMs: Int?
    private var lastNowMs: Int64?
    private var lastPlaying = false
    private var cooldownUntilMs: Int64 = 0
    private var pendingSeek: (ruleId: String, positionMs: Int)?
    private var consumed = Set<String>()
    private var bypassed = Set<String>()

    mutating func clear(trackId: String = "") {
        document = nil
        resetPlayback(trackId: trackId)
    }

    mutating func resetPlayback(trackId: String) {
        playbackTrackId = trackId
        lastPositionMs = nil
        lastNowMs = nil
        lastPlaying = false
        cooldownUntilMs = 0
        pendingSeek = nil
        consumed.removeAll()
        bypassed.removeAll()
    }

    @discardableResult
    mutating func setDocument(_ next: SongSegmentRulesDocument) -> Bool {
        guard Self.validDocument(next) else { return false }
        if let current = document,
           current.trackId == next.trackId,
           current.revision == next.revision { return false }
        document = SongSegmentRulesDocument(
            version: next.version,
            trackId: next.trackId,
            revision: next.revision,
            rules: next.rules.sorted {
                $0.startMs != $1.startMs ? $0.startMs < $1.startMs
                    : $0.endMs != $1.endMs ? $0.endMs < $1.endMs
                    : $0.id < $1.id
            }
        )
        pendingSeek = nil
        cooldownUntilMs = 0
        consumed.removeAll()
        bypassed.removeAll()
        return true
    }

    mutating func evaluate(_ sample: SongSegmentPlaybackSample) -> SongSegmentSkipAction? {
        guard Self.isTrackID(sample.trackId) else { return nil }
        if playbackTrackId != sample.trackId { resetPlayback(trackId: sample.trackId) }

        let naturalRepeat = lastPositionMs.map { previous in
            sample.durationMs > 0
                && previous >= sample.durationMs - 3_000
                && sample.positionMs <= 1_500
        } ?? false
        if naturalRepeat {
            consumed.removeAll()
            bypassed.removeAll()
            pendingSeek = nil
            cooldownUntilMs = 0
        }

        if let pending = pendingSeek {
            if sample.positionMs >= pending.positionMs - Self.seekTargetToleranceMs {
                pendingSeek = nil
            } else if sample.nowMs < cooldownUntilMs {
                remember(sample)
                return nil
            } else {
                consumed.remove(pending.ruleId)
                pendingSeek = nil
            }
        }

        if !naturalRepeat,
           let previousPosition = lastPositionMs,
           let previousNow = lastNowMs {
            let elapsed = max(0, sample.nowMs - previousNow)
            let expected = previousPosition + (lastPlaying ? Int(min(elapsed, Int64(Int.max))) : 0)
            if abs(sample.positionMs - expected) > Self.manualSeekThresholdMs {
                for rule in document?.rules ?? []
                where (sample.positionMs >= rule.startMs && sample.positionMs < rule.endMs)
                    || (sample.positionMs < rule.startMs && expected >= rule.startMs) {
                    bypassed.insert(rule.id)
                }
            }
        }

        if let rules = document?.rules {
            bypassed = bypassed.filter { id in
                guard let rule = rules.first(where: { $0.id == id }) else { return false }
                return sample.positionMs < rule.endMs
            }
        } else {
            bypassed.removeAll()
        }
        remember(sample)

        guard sample.isPlaying,
              sample.nowMs >= cooldownUntilMs,
              let document,
              document.trackId == sample.trackId,
              let rule = document.rules.first(where: { rule in
                  guard rule.enabled,
                        !consumed.contains(rule.id),
                        !bypassed.contains(rule.id) else { return false }
                  return sample.positionMs >= rule.startMs
                      && sample.positionMs < rule.endMs
                      && rule.endMs - sample.positionMs >= Self.minimumRemainingMs
              }) else { return nil }

        consumed.insert(rule.id)
        pendingSeek = (rule.id, rule.endMs)
        cooldownUntilMs = sample.nowMs + Self.seekCooldownMs
        return SongSegmentSkipAction(
            trackId: sample.trackId,
            positionMs: rule.endMs,
            ruleId: rule.id,
            category: rule.category
        )
    }

    mutating func seekFailed(ruleId: String) {
        consumed.remove(ruleId)
        if pendingSeek?.ruleId == ruleId { pendingSeek = nil }
    }

    private mutating func remember(_ sample: SongSegmentPlaybackSample) {
        lastPositionMs = sample.positionMs
        lastNowMs = sample.nowMs
        lastPlaying = sample.isPlaying
    }

    private static func validDocument(_ document: SongSegmentRulesDocument) -> Bool {
        guard document.version == 1,
              document.revision >= 0,
              isTrackID(document.trackId),
              document.rules.count <= 128 else { return false }
        var ids = Set<String>()
        for rule in document.rules {
            guard validToken(rule.id, maximum: 64),
                  validToken(rule.category, maximum: 32),
                  rule.startMs >= 0,
                  rule.endMs > rule.startMs,
                  rule.endMs <= 86_400_000,
                  ids.insert(rule.id).inserted else { return false }
        }
        return true
    }

    private static func validToken(_ value: String, maximum: Int) -> Bool {
        guard !value.isEmpty, value.utf8.count <= maximum else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 48 && scalar.value <= 57)
                || (scalar.value >= 65 && scalar.value <= 90)
                || (scalar.value >= 97 && scalar.value <= 122)
                || scalar.value == 45 || scalar.value == 46 || scalar.value == 95
        }
    }

    private static func isTrackID(_ value: String) -> Bool {
        value.utf8.count == 22 && value.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57)
                || ($0.value >= 65 && $0.value <= 90)
                || ($0.value >= 97 && $0.value <= 122)
        }
    }
}

final class SongSegmentSkipper {
    static let shared = SongSegmentSkipper()

    private static let refreshIntervalMs: Int64 = 60_000
    private static let ownerAssociationKey: UnsafeRawPointer = unsafeBitCast(
        NSSelectorFromString("mitmLyrics.songSegmentOwner"),
        to: UnsafeRawPointer.self
    )

    private let queue = DispatchQueue(label: "app.hentaku.mitm-lyrics.song-segments")
    private let ownerID = UUID().uuidString as NSString
    private var machine = SongSegmentStateMachine()
    private var currentTrackId = ""
    private var latestEvent: LyricsPlaybackEvent?
    private var lastFetchAtMs: Int64 = 0
    private var fetchGeneration = 0
    private var fetchInFlight = false
    private var pollTimer: DispatchSourceTimer?

    private init() {}

    func process(event: LyricsPlaybackEvent, player: AnyObject) {
        guard claim(player: player) else { return }
        queue.async { [weak self] in
            self?.processOnQueue(event: event)
        }
    }

    private func processOnQueue(event: LyricsPlaybackEvent) {
        let now = monotonicMs()
        guard !event.trackId.isEmpty else {
            clearCurrentTrack()
            return
        }
        if event.trackId != currentTrackId {
            currentTrackId = event.trackId
            latestEvent = event
            lastFetchAtMs = 0
            fetchGeneration += 1
            fetchInFlight = false
            machine.clear(trackId: event.trackId)
            fetchRules(trackId: event.trackId)
        } else {
            latestEvent = event
        }
        evaluate(event: event, positionMs: event.positionMs, isPlaying: event.isPlaying, nowMs: now)
        if event.isPlaying {
            startPolling()
        } else {
            stopPolling()
        }
    }

    private func evaluate(event: LyricsPlaybackEvent, positionMs: Int, isPlaying: Bool, nowMs: Int64) {
        let sample = SongSegmentPlaybackSample(
            trackId: event.trackId,
            positionMs: max(0, positionMs),
            durationMs: max(0, event.durationMs),
            isPlaying: isPlaying,
            nowMs: nowMs
        )
        guard let action = machine.evaluate(sample) else { return }
        let succeeded = LyricsTimelinePlayerBridge.shared.seek(
            positionMs: action.positionMs,
            expectedTrackID: action.trackId
        )
        if !succeeded {
            machine.seekFailed(ruleId: action.ruleId)
            writeDebugLog("[SongSegments] seek rejected track=\(action.trackId) rule=\(action.ruleId)")
        } else {
            writeDebugLog("[SongSegments] skipped \(action.category) rule=\(action.ruleId) -> \(action.positionMs)ms")
        }
    }

    private func startPolling() {
        guard pollTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.poll() }
        pollTimer = timer
        timer.resume()
    }

    private func stopPolling() {
        pollTimer?.cancel()
        pollTimer = nil
    }

    private func poll() {
        guard let event = latestEvent,
              event.trackId == currentTrackId,
              event.isPlaying else {
            stopPolling()
            return
        }
        let now = monotonicMs()
        let snapshot = LyricsTimelinePlayerBridge.shared.snapshot()
        guard snapshot.trackId == event.trackId else { return }
        evaluate(event: event, positionMs: snapshot.positionMs, isPlaying: snapshot.isPlaying, nowMs: now)
        if now - lastFetchAtMs >= Self.refreshIntervalMs { fetchRules(trackId: event.trackId) }
    }

    private func fetchRules(trackId: String) {
        guard !fetchInFlight, trackId == currentTrackId else { return }
        let configuration: LyricsShareEditorConfiguration
        do {
            configuration = try LyricsShareEditorConfiguration.current()
        } catch {
            return
        }
        guard var components = URLComponents(
            url: configuration.segmentsEndpointURL,
            resolvingAgainstBaseURL: false
        ) else { return }
        components.queryItems = [URLQueryItem(name: "trackId", value: trackId)]
        guard let url = components.url else { return }
        lastFetchAtMs = monotonicMs()
        fetchInFlight = true
        fetchGeneration += 1
        let generation = fetchGeneration
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.token.isEmpty {
            request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            self?.queue.async {
                guard let self else { return }
                guard generation == self.fetchGeneration,
                      trackId == self.currentTrackId else { return }
                self.fetchInFlight = false
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode),
                      let data,
                      let payload = try? JSONDecoder().decode(SongSegmentRulesResponse.self, from: data),
                      payload.ok,
                      let document = payload.document,
                      document.trackId == trackId else { return }
                self.lastFetchAtMs = self.monotonicMs()
                _ = self.machine.setDocument(document)
            }
        }.resume()
    }

    private func clearCurrentTrack() {
        currentTrackId = ""
        latestEvent = nil
        lastFetchAtMs = 0
        fetchGeneration += 1
        fetchInFlight = false
        machine.clear()
        stopPolling()
    }

    private func claim(player: AnyObject) -> Bool {
        objc_sync_enter(player)
        defer { objc_sync_exit(player) }
        if let existing = objc_getAssociatedObject(player, Self.ownerAssociationKey) as? NSString {
            return existing == ownerID
        }
        objc_setAssociatedObject(
            player,
            Self.ownerAssociationKey,
            ownerID,
            .OBJC_ASSOCIATION_COPY_NONATOMIC
        )
        return true
    }

    private func monotonicMs() -> Int64 {
        Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }
}
