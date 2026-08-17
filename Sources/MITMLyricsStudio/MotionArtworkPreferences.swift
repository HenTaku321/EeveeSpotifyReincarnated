import Foundation

final class MotionArtworkPreferences {
    static let shared = MotionArtworkPreferences()
    static let maximumDisabledAlbums = 512

    private let defaults: UserDefaults
    private let globalEnabledKey = "mitmLyricsStudio.motionArtwork.globalEnabled.v1"
    private let disabledAlbumsKey = "mitmLyricsStudio.motionArtwork.disabledAlbums.v1"

    init(defaults: UserDefaults = .container) {
        self.defaults = defaults
    }

    var globalEnabled: Bool {
        get {
            guard defaults.object(forKey: globalEnabledKey) != nil else { return true }
            return defaults.bool(forKey: globalEnabledKey)
        }
        set { defaults.set(newValue, forKey: globalEnabledKey) }
    }

    func isDisabled(_ identity: MotionArtworkIdentity) -> Bool {
        disabledAlbumTokens.contains(identity.preferenceToken)
    }

    func setDisabled(_ disabled: Bool, for identity: MotionArtworkIdentity) {
        var tokens = disabledAlbumTokens
        if disabled {
            tokens.removeAll { $0 == identity.preferenceToken }
            tokens.append(identity.preferenceToken)
            if tokens.count > Self.maximumDisabledAlbums {
                tokens.removeFirst(tokens.count - Self.maximumDisabledAlbums)
            }
        } else {
            tokens.removeAll { $0 == identity.preferenceToken }
        }
        defaults.set(tokens, forKey: disabledAlbumsKey)
    }

    private var disabledAlbumTokens: [String] {
        let raw = defaults.array(forKey: disabledAlbumsKey) as? [String] ?? []
        return Array(raw.lazy.filter(Self.isValidPreferenceToken).prefix(Self.maximumDisabledAlbums))
    }

    private static func isValidPreferenceToken(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 800 else { return false }
        return value.hasPrefix("id:") || value.hasPrefix("name:")
    }
}
