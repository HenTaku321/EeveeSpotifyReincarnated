import Foundation
import UIKit

@objc protocol SPTURL {
    func spt_trackIdentifier() -> String
}

@objc protocol SPTPlayerTrack {
    func metadata() -> [String: String]
    func trackTitle() -> String
    func artistName() -> String
    func URI() -> SPTURL
}

extension SPTPlayerTrack {
    var trackIdentifier: String { URI().spt_trackIdentifier() }
}

@objc protocol StatefulPlayerImplementation {
    func currentTrack() -> SPTPlayerTrack?
}

var statefulPlayer: StatefulPlayerImplementation?
var capturedTrackTitle: String?
var capturedArtistName: String?
var capturedAlbumName: String?
var capturedTrackId: String?

extension UserDefaults {
    static var container: UserDefaults = .standard
}

func writeDebugLog(_ message: String) {
    let line = "[\(Date())] \(message)\n"
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("mitm-lyrics-studio.log", isDirectory: false)
    guard let data = line.data(using: .utf8) else { return }
    if FileManager.default.fileExists(atPath: url.path),
       let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: url, options: .atomic)
    }
}

struct WindowHelper {
    static let shared = WindowHelper()

    func viewController(for view: UIView) -> UIViewController? {
        var responder: UIResponder? = view
        while let next = responder?.next {
            if let controller = next as? UIViewController { return controller }
            responder = next
        }
        return nil
    }
}

final class BundleHelper {
    static let shared = BundleHelper()

    private let bundle: Bundle?

    private init() {
        let name = "MITMLyricsStudio.bundle"
        var candidates = [URL]()
        if let path = Bundle.main.path(forResource: "MITMLyricsStudio", ofType: "bundle") {
            candidates.append(URL(fileURLWithPath: path, isDirectory: true))
        }
        candidates.append(Bundle.main.bundleURL.appendingPathComponent(name, isDirectory: true))
        candidates.append(URL(fileURLWithPath: "/var/jb/Library/Application Support/\(name)", isDirectory: true))
        candidates.append(URL(fileURLWithPath: "/Library/Application Support/\(name)", isDirectory: true))
        bundle = candidates.lazy.compactMap { Bundle(url: $0) }.first
        if bundle == nil { writeDebugLog("[Bootstrap] MITMLyricsStudio.bundle not found") }
    }

    var shareEditorDirectoryURL: URL? {
        resourceDirectory(named: "ShareEditor")
    }

    var shareEditorIndexURL: URL? {
        indexURL(in: shareEditorDirectoryURL)
    }

    var timelineEditorDirectoryURL: URL? {
        resourceDirectory(named: "TimelineEditor")
    }

    var timelineEditorIndexURL: URL? {
        indexURL(in: timelineEditorDirectoryURL)
    }

    private func resourceDirectory(named name: String) -> URL? {
        guard let url = bundle?.resourceURL?.appendingPathComponent(name, isDirectory: true),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    private func indexURL(in directory: URL?) -> URL? {
        guard let url = directory?.appendingPathComponent("index.html", isDirectory: false),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
}
