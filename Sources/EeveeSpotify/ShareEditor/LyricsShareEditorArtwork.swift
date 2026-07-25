import Foundation
import ImageIO
import UIKit

final class LyricsShareEditorArtworkLoader {
    static let maximumArtworkBytes = 2 * 1024 * 1024

    private static let maximumMetadataBytes = 128 * 1024
    private static let maximumDimension = 4096
    private static let maximumPixels = 16_777_216
    private static let renderedDimension: CGFloat = 1024

    private var activeRequestID: UUID?
    private var completion: ((String?) -> Void)?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var sessionDelegate: LyricsShareEditorSessionDelegate?

    func resolve(track: LyricsShareEditorTrack, preferredURL: URL?, completion: @escaping (String?) -> Void) {
        cancel()
        let requestID = UUID()
        activeRequestID = requestID
        self.completion = completion
        if let preferredURL = preferredURL {
            downloadArtwork(from: preferredURL, requestID: requestID, fallbackTrack: track)
        } else {
            fetchOEmbedArtworkURL(for: track, requestID: requestID)
        }
    }

    func cancel() {
        activeRequestID = nil
        completion = nil
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        sessionDelegate = nil
    }

    static func allowedArtworkURL(from rawValue: String) -> URL? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("spotify:image:") {
            let identifier = String(value.dropFirst("spotify:image:".count))
            guard (32...128).contains(identifier.utf8.count),
                  identifier.unicodeScalars.allSatisfy({
                      ($0.value >= 48 && $0.value <= 57)
                          || ($0.value >= 65 && $0.value <= 70)
                          || ($0.value >= 97 && $0.value <= 102)
                  }) else {
                return nil
            }
            return URL(string: "https://i.scdn.co/image/\(identifier)")
        }

        guard let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased(),
              host == "i.scdn.co"
                  || host == "mosaic.scdn.co"
                  || (host.hasPrefix("image-cdn-") && host.hasSuffix(".spotifycdn.com")) else {
            return nil
        }
        return url
    }

    private func fetchOEmbedArtworkURL(for track: LyricsShareEditorTrack, requestID: UUID) {
        var components = URLComponents(string: "https://open.spotify.com/oembed")
        components?.queryItems = [
            URLQueryItem(name: "url", value: "https://open.spotify.com/track/\(track.trackId)")
        ]
        guard let url = components?.url else {
            finish(requestID: requestID, dataURL: nil)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        start(request: request, maximumBytes: Self.maximumMetadataBytes, requestID: requestID) {
            [weak self] data, response, error in
            guard let self = self, self.activeRequestID == requestID else { return }
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  http.url?.scheme?.lowercased() == "https",
                  http.url?.host?.lowercased() == "open.spotify.com",
                  let mimeType = http.mimeType?.lowercased(),
                  mimeType == "application/json" || mimeType.hasSuffix("+json"),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let thumbnail = object["thumbnail_url"] as? String,
                  let artworkURL = Self.allowedArtworkURL(from: thumbnail) else {
                self.finish(requestID: requestID, dataURL: nil)
                return
            }
            self.downloadArtwork(from: artworkURL, requestID: requestID, fallbackTrack: nil)
        }
    }

    private func downloadArtwork(from url: URL, requestID: UUID, fallbackTrack: LyricsShareEditorTrack?) {
        guard let allowedURL = Self.allowedArtworkURL(from: url.absoluteString) else {
            finishOrFetchOEmbed(requestID: requestID, fallbackTrack: fallbackTrack)
            return
        }
        var request = URLRequest(url: allowedURL)
        request.timeoutInterval = 10
        request.setValue("image/avif,image/webp,image/png,image/jpeg", forHTTPHeaderField: "Accept")
        start(request: request, maximumBytes: Self.maximumArtworkBytes, requestID: requestID) {
            [weak self] data, response, error in
            guard let self = self, self.activeRequestID == requestID else { return }
            guard error == nil,
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let finalURL = http.url,
                  Self.allowedArtworkURL(from: finalURL.absoluteString) != nil,
                  let mimeType = http.mimeType?.lowercased(),
                  ["image/jpeg", "image/png", "image/webp", "image/avif"].contains(mimeType),
                  let dataURL = Self.validatedArtworkDataURL(data) else {
                self.finishOrFetchOEmbed(requestID: requestID, fallbackTrack: fallbackTrack)
                return
            }
            self.finish(requestID: requestID, dataURL: dataURL)
        }
    }

    private func finishOrFetchOEmbed(requestID: UUID, fallbackTrack: LyricsShareEditorTrack?) {
        guard let fallbackTrack = fallbackTrack else {
            finish(requestID: requestID, dataURL: nil)
            return
        }
        fetchOEmbedArtworkURL(for: fallbackTrack, requestID: requestID)
    }

    private func start(request: URLRequest, maximumBytes: Int, requestID: UUID,
                       completion: @escaping (Data, URLResponse?, Error?) -> Void) {
        task?.cancel()
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        sessionDelegate = nil

        let delegate = LyricsShareEditorSessionDelegate(
            maximumBytes: maximumBytes,
            oversizedResponseMessage: "专辑封面响应超过大小限制。"
        ) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.activeRequestID == requestID else { return }
                self.task = nil
                self.session?.finishTasksAndInvalidate()
                self.session = nil
                self.sessionDelegate = nil
                completion(data, response, error)
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        self.sessionDelegate = delegate
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    private func finish(requestID: UUID, dataURL: String?) {
        guard activeRequestID == requestID else { return }
        let completion = self.completion
        activeRequestID = nil
        self.completion = nil
        task?.cancel()
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        sessionDelegate = nil
        completion?(dataURL)
    }

    private static func validatedArtworkDataURL(_ data: Data) -> String? {
        guard !data.isEmpty, data.count <= maximumArtworkBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0,
              width <= maximumDimension, height <= maximumDimension,
              width <= maximumPixels / height,
              let image = UIImage(data: data) else {
            return nil
        }

        let largestSide = max(image.size.width, image.size.height)
        let scale = largestSide > renderedDimension ? renderedDimension / largestSide : 1
        let targetSize = CGSize(
            width: max(1, (image.size.width * scale).rounded()),
            height: max(1, (image.size.height * scale).rounded())
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: targetSize))
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        for quality in [0.86, 0.74, 0.62, 0.50] {
            guard let encoded = normalized.jpegData(compressionQuality: quality) else { continue }
            if !encoded.isEmpty, encoded.count <= maximumArtworkBytes {
                return "data:image/jpeg;base64,\(encoded.base64EncodedString())"
            }
        }
        return nil
    }
}
