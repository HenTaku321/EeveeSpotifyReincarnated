import Foundation
import MediaPlayer

enum LyricsShareEditorError: LocalizedError {
    case configuration(String)
    case noCurrentTrack
    case missingTrackField(String)
    case invalidResponse(String)
    case export(String)

    var errorDescription: String? {
        switch self {
        case .configuration(let message),
             .invalidResponse(let message),
             .export(let message):
            return message
        case .noCurrentTrack:
            return "未读取到当前曲目。请先播放歌曲，再重新打开歌词编辑器。"
        case .missingTrackField(let field):
            return "当前曲目缺少\(field)，无法匹配 GitHub 歌词。"
        }
    }
}

struct LyricsShareEditorTrack: Encodable {
    let trackId: String
    let title: String
    let artist: String
    let album: String
}

struct LyricsShareEditorTrackCandidate {
    let trackId: String
    let title: String
    let artist: String
    let album: String

    func validated(albumOverride: String? = nil) throws -> LyricsShareEditorTrack {
        let normalizedTrackID = trackId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedTrackID.utf8.count == 22,
              normalizedTrackID.unicodeScalars.allSatisfy({
                  ($0.value >= 48 && $0.value <= 57)
                      || ($0.value >= 65 && $0.value <= 90)
                      || ($0.value >= 97 && $0.value <= 122)
              }) else {
            throw LyricsShareEditorError.invalidResponse("当前曲目的 Spotify track ID 格式无效。")
        }
        let normalizedTitle = try Self.validatedText(title, field: "歌曲名")
        let normalizedArtist = try Self.validatedText(artist, field: "艺术家")
        let resolvedAlbum = Self.trimmed(albumOverride) ?? album
        let normalizedAlbum = try Self.validatedText(resolvedAlbum, field: "专辑名")
        return LyricsShareEditorTrack(
            trackId: normalizedTrackID,
            title: normalizedTitle,
            artist: normalizedArtist,
            album: normalizedAlbum
        )
    }

    private static func validatedText(_ value: String, field: String) throws -> String {
        guard let value = trimmed(value) else { throw LyricsShareEditorError.missingTrackField(field) }
        guard value.utf8.count <= 4096,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw LyricsShareEditorError.invalidResponse("当前曲目的\(field)过长或包含控制字符。")
        }
        return value
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

enum LyricsShareEditorTrackResolver {
    static func currentCandidate() throws -> LyricsShareEditorTrackCandidate {
        dispatchPrecondition(condition: .onQueue(DispatchQueue.main))

        let playerTrack = statefulPlayer?.currentTrack() ?? nowPlayingScrollViewController?.loadedTrack
        let observedTrack = LyricsTimelinePlayerBridge.shared.capturedTrackCandidate()
        let nowPlaying = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let liveTrackID = trimmed(playerTrack?.trackIdentifier)
        let observedTrackID = trimmed(observedTrack?.trackId)
        let trackID = liveTrackID ?? observedTrackID ?? trimmed(capturedTrackId)
        guard let trackID = trackID else { throw LyricsShareEditorError.noCurrentTrack }
        let matchingPlayerTrack = liveTrackID == trackID ? playerTrack : nil
        let matchingObservedTrack = observedTrackID == trackID ? observedTrack : nil
        let capturedMetadataMatches = trimmed(capturedTrackId) == trackID

        let metadata: [String: String]
        if let track = matchingPlayerTrack,
           let object = track as? NSObject,
           object.responds(to: NSSelectorFromString("metadata")) {
            metadata = track.metadata()
        } else {
            metadata = [:]
        }
        let title = firstNonempty([
            matchingPlayerTrack.map { $0.trackTitle() },
            metadataValue(in: metadata, keys: ["title", "track_title", "trackName"]),
            matchingObservedTrack?.title,
            capturedMetadataMatches ? capturedTrackTitle : nil,
            nowPlaying[MPMediaItemPropertyTitle] as? String
        ])
        let artist = firstNonempty([
            matchingPlayerTrack.map { $0.artistName() },
            metadataValue(in: metadata, keys: ["artist", "artist_name", "artistName"]),
            matchingObservedTrack?.artist,
            capturedMetadataMatches ? capturedArtistName : nil,
            nowPlaying[MPMediaItemPropertyArtist] as? String
        ])
        let album = firstNonempty([
            metadataValue(in: metadata, keys: [
                "album", "album_name", "album_title", "albumName", "albumTitle", "context_album_name"
            ]),
            matchingObservedTrack?.album,
            capturedMetadataMatches ? capturedAlbumName : nil,
            nowPlayingAlbum(in: nowPlaying, matchingTitle: title, artist: artist)
        ])

        return LyricsShareEditorTrackCandidate(
            trackId: trackID,
            title: title ?? "",
            artist: artist ?? "",
            album: album ?? ""
        )
    }

    static func remember(_ track: LyricsShareEditorTrack) {
        capturedTrackId = track.trackId
        capturedTrackTitle = track.title
        capturedArtistName = track.artist
        capturedAlbumName = track.album
    }

    private static func firstNonempty(_ values: [String?]) -> String? {
        for value in values {
            if let value = trimmed(value) { return value }
        }
        return nil
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func metadataValue(in metadata: [String: String], keys: Set<String>) -> String? {
        let normalizedKeys = Set(keys.map { $0.lowercased() })
        return metadata.first { normalizedKeys.contains($0.key.lowercased()) }?.value
    }

    private static func nowPlayingAlbum(in info: [String: Any], matchingTitle title: String?, artist: String?) -> String? {
        guard equalIdentity(info[MPMediaItemPropertyTitle] as? String, title),
              equalIdentity(info[MPMediaItemPropertyArtist] as? String, artist) else {
            return nil
        }
        return trimmed(info[MPMediaItemPropertyAlbumTitle] as? String)
    }

    private static func equalIdentity(_ left: String?, _ right: String?) -> Bool {
        guard let left = trimmed(left), let right = trimmed(right) else { return false }
        return left.compare(right, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
    }
}

struct LyricsShareEditorLyricsRequest: Encodable {
    let track: LyricsShareEditorTrack
}
