import Foundation

enum LyricsStatusIndexKind: String, Codable {
    case lyrics
    case instrumental
    case noLyrics = "no-lyrics"
}

struct LyricsStatusIndexEntry: Codable, Equatable {
    let trackId: String
    let kind: LyricsStatusIndexKind
    let isStatic: Bool
    let artist: String?
    let title: String?
    let album: String?
    let updatedAt: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case trackId
        case kind
        case isStatic = "static"
        case artist
        case title
        case album
        case updatedAt
        case reason
    }

    var badgeLabel: String {
        switch kind {
        case .lyrics: return "静态歌词"
        case .instrumental: return "纯音乐"
        case .noLyrics: return "无歌词"
        }
    }
}

enum LyricsStatusIndexFreshness: String {
    case empty
    case fresh
    case stale
}

struct LyricsStatusIndexSnapshot {
    let freshness: LyricsStatusIndexFreshness
    let revision: Int64
    let entryCount: Int
    let fetchedAt: TimeInterval
}

final class LyricsStatusIndexStore {
    static let shared = LyricsStatusIndexStore()
    static let didChangeNotification = Notification.Name("LyricsStatusIndexStoreDidChange")

    private struct Document: Codable {
        let version: Int
        let revision: Int64
        let updatedAt: String?
        let entries: [LyricsStatusIndexEntry]
    }

    private struct PersistentRecord: Codable {
        let document: Document
        let etag: String
        let endpoint: String
        let fetchedAt: TimeInterval
    }

    private static let maximumResponseBytes = 4 * 1024 * 1024
    private static let cacheFilename = "lyrics-status-index-v1.json"
    private static let foregroundNotification = Notification.Name("UIApplicationDidBecomeActiveNotification")

    private let stateQueue = DispatchQueue(label: "com.eevee.lyrics.status-index", qos: .utility)
    private let session: URLSession
    private let cacheURL: URL?
    private var currentDocument: Document?
    private var entriesByTrackID: [String: LyricsStatusIndexEntry] = [:]
    private var etag = ""
    private var endpoint = ""
    private var fetchedAt: TimeInterval = 0
    private var freshness: LyricsStatusIndexFreshness = .empty
    private var started = false
    private var foregroundObserver: NSObjectProtocol?
    private var requestSequence: UInt64 = 0
    private var lastAcceptedSequence: UInt64 = 0
    private var requestsInFlight = 0

    init(session: URLSession = .shared, applicationSupportDirectory: URL? = nil) {
        self.session = session
        let applicationSupport = applicationSupportDirectory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        self.cacheURL = applicationSupport?
            .appendingPathComponent("LyricsEditor", isDirectory: true)
            .appendingPathComponent(Self.cacheFilename, isDirectory: false)
    }

    func start() {
        stateQueue.async { [weak self] in
            guard let self = self, !self.started else { return }
            self.started = true
            self.restorePersistentRecordLocked()
            self.foregroundObserver = NotificationCenter.default.addObserver(
                forName: Self.foregroundNotification,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                self?.refresh(force: true)
            }
            self.refresh(force: true)
        }
    }

    func refresh(force: Bool = false) {
        stateQueue.async { [weak self] in
            self?.beginRefreshLocked(force: force)
        }
    }

    func entry(forTrackID value: String) -> LyricsStatusIndexEntry? {
        guard let trackID = Self.normalizedTrackID(value) else { return nil }
        return stateQueue.sync { entriesByTrackID[trackID] }
    }

    func snapshot() -> LyricsStatusIndexSnapshot {
        stateQueue.sync {
            LyricsStatusIndexSnapshot(
                freshness: freshness,
                revision: currentDocument?.revision ?? 0,
                entryCount: entriesByTrackID.count,
                fetchedAt: fetchedAt
            )
        }
    }

    static func normalizedTrackID(_ value: String) -> String? {
        let trackID = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let utf8 = Array(trackID.utf8)
        guard utf8.count == 22,
              utf8.allSatisfy({ byte in
                  (byte >= 48 && byte <= 57)
                      || (byte >= 65 && byte <= 90)
                      || (byte >= 97 && byte <= 122)
              }) else { return nil }
        return trackID
    }

    private func beginRefreshLocked(force: Bool) {
        guard force || requestsInFlight == 0 else { return }
        let configuration: LyricsShareEditorConfiguration
        do {
            configuration = try .current()
        } catch {
            recordFailureLocked()
            return
        }

        requestSequence &+= 1
        let sequence = requestSequence
        let requestEndpoint = configuration.lyricsStatusIndexEndpointURL.absoluteString
        var request = URLRequest(url: configuration.lyricsStatusIndexEndpointURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.token.isEmpty {
            request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
        }
        if endpoint == requestEndpoint, !etag.isEmpty {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        requestsInFlight += 1
        session.dataTask(with: request) { [weak self] data, response, error in
            self?.stateQueue.async {
                self?.finishRefreshLocked(
                    sequence: sequence,
                    requestEndpoint: requestEndpoint,
                    data: data,
                    response: response,
                    error: error
                )
            }
        }.resume()
    }

    private func finishRefreshLocked(sequence: UInt64, requestEndpoint: String,
                                     data: Data?, response: URLResponse?, error: Error?) {
        requestsInFlight = max(0, requestsInFlight - 1)
        guard error == nil, let http = response as? HTTPURLResponse else {
            if sequence >= lastAcceptedSequence { recordFailureLocked() }
            return
        }
        if http.statusCode == 304 {
            guard currentDocument != nil, endpoint == requestEndpoint,
                  sequence >= lastAcceptedSequence else { return }
            lastAcceptedSequence = sequence
            etag = http.value(forHTTPHeaderField: "ETag")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? etag
            fetchedAt = Date().timeIntervalSince1970
            freshness = .fresh
            persistCurrentRecordLocked()
            notifyChangeLocked()
            return
        }
        guard (200..<300).contains(http.statusCode),
              let data = data, data.count <= Self.maximumResponseBytes,
              let document = try? JSONDecoder().decode(Document.self, from: data),
              let normalizedEntries = Self.validatedEntries(document) else {
            if sequence >= lastAcceptedSequence { recordFailureLocked() }
            return
        }
        if let currentDocument = currentDocument,
           document.revision < currentDocument.revision {
            return
        }
        if sequence < lastAcceptedSequence,
           let currentDocument = currentDocument,
           document.revision <= currentDocument.revision {
            return
        }

        lastAcceptedSequence = sequence
        if currentDocument == nil || document.revision > currentDocument!.revision {
            currentDocument = document
            entriesByTrackID = normalizedEntries
        }
        etag = http.value(forHTTPHeaderField: "ETag")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        endpoint = requestEndpoint
        fetchedAt = Date().timeIntervalSince1970
        freshness = .fresh
        persistCurrentRecordLocked()
        notifyChangeLocked()
    }

    private static func validatedEntries(_ document: Document) -> [String: LyricsStatusIndexEntry]? {
        guard document.version == 1, document.revision >= 0 else { return nil }
        var result: [String: LyricsStatusIndexEntry] = [:]
        for entry in document.entries {
            guard let trackID = normalizedTrackID(entry.trackId),
                  trackID == entry.trackId,
                  entry.isStatic,
                  entry.reason?.trimmingCharacters(in: .whitespacesAndNewlines) != "lyrics-source-not-found",
                  result[trackID] == nil else { return nil }
            result[trackID] = entry
        }
        return result
    }

    private func restorePersistentRecordLocked() {
        guard let cacheURL = cacheURL,
              let values = try? cacheURL.resourceValues(forKeys: [.fileSizeKey]),
              let fileSize = values.fileSize,
              fileSize <= Self.maximumResponseBytes,
              let data = try? Data(contentsOf: cacheURL),
              data.count <= Self.maximumResponseBytes,
              let record = try? JSONDecoder().decode(PersistentRecord.self, from: data),
              let normalizedEntries = Self.validatedEntries(record.document) else { return }
        currentDocument = record.document
        entriesByTrackID = normalizedEntries
        etag = record.etag.trimmingCharacters(in: .whitespacesAndNewlines)
        endpoint = record.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        fetchedAt = max(0, record.fetchedAt)
        freshness = .stale
        notifyChangeLocked()
    }

    private func persistCurrentRecordLocked() {
        guard let document = currentDocument, let cacheURL = cacheURL else { return }
        let record = PersistentRecord(
            document: document,
            etag: etag,
            endpoint: endpoint,
            fetchedAt: fetchedAt
        )
        guard let data = try? JSONEncoder().encode(record) else { return }
        do {
            try FileManager.default.createDirectory(
                at: cacheURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: cacheURL, options: .atomic)
        } catch {
            writeDebugLog("[LyricsStatusIndex] cache write failed: \(error.localizedDescription)")
        }
    }

    private func recordFailureLocked() {
        freshness = currentDocument == nil ? .empty : .stale
        notifyChangeLocked()
    }

    private func notifyChangeLocked() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
        }
    }
}
