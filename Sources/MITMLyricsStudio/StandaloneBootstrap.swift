import Foundation
import Orion

struct MITMLyricsStudio: Tweak {
    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        guard version.hasPrefix("9.1.") else {
            writeDebugLog("[Bootstrap] unsupported Spotify version \(version)")
            return
        }
        writeDebugLog("[Bootstrap] MITM Lyrics Studio starting on Spotify \(version)")
        activateStandalonePlayerHooks()
        activateLyricsEditorEntries()
    }
}
