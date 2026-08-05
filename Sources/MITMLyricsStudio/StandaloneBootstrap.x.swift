import Foundation
import Orion

private let standaloneActivationMaximumAttempts = 30
private let standaloneActivationRetryDelay: TimeInterval = 1

private func scheduleStandaloneActivation(attempt: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + standaloneActivationRetryDelay) {
        let playerReady = activateStandalonePlayerHooks()
        let entriesReady = activateLyricsEditorEntries()
        if playerReady && entriesReady {
            writeDebugLog("[Bootstrap] standalone hooks ready on attempt \(attempt)")
            return
        }

        guard attempt < standaloneActivationMaximumAttempts else {
            writeDebugLog(
                "[Bootstrap] standalone hook activation stopped after \(attempt) attempts "
                    + "(player=\(playerReady), entries=\(entriesReady))"
            )
            return
        }
        scheduleStandaloneActivation(attempt: attempt + 1)
    }
}

struct MITMLyricsStudio: Tweak {
    init() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        guard version.hasPrefix("9.1.") else {
            writeDebugLog("[Bootstrap] unsupported Spotify version \(version)")
            return
        }
        writeDebugLog("[Bootstrap] MITM Lyrics Studio starting on Spotify \(version)")
        LyricsStatusIndexStore.shared.start()
        scheduleStandaloneActivation(attempt: 1)
    }
}
