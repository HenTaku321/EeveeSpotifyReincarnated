import Foundation

struct MotionArtworkIdentity: Equatable {
    let artist: String
    let album: String
    let spotifyAlbumID: String?

    init?(artist: String, album: String, spotifyAlbumID: String? = nil) {
        let artist = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        let album = album.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !artist.isEmpty, !album.isEmpty else { return nil }

        self.artist = artist
        self.album = album
        self.spotifyAlbumID = spotifyAlbumID.flatMap(Self.validSpotifyAlbumID)
    }

    var key: String {
        Self.normalized(artist) + "\u{0}" + Self.normalized(album)
    }

    var preferenceToken: String {
        if let spotifyAlbumID { return "id:\(spotifyAlbumID)" }
        return "name:\(key)"
    }

    private static func validSpotifyAlbumID(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 128,
              value.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
              }) else { return nil }
        return value
    }

    private static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
