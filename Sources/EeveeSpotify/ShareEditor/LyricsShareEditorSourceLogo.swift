import Foundation
import ImageIO

final class LyricsShareEditorSourceLogoLoader {
    private static let maximumBytes = 8 * 1024 * 1024
    private static let maximumDimension = 8192
    private static let maximumPixels = 16 * 1024 * 1024

    private var activeRequestID: UUID?
    private var completion: (([String: String]) -> Void)?
    private var pendingRequests = [(variant: String, url: URL)]()
    private var resolvedLogos = [String: String]()
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var sessionDelegate: LyricsShareEditorSessionDelegate?

    func resolve(configuration: LyricsShareEditorConfiguration,
                 completion: @escaping ([String: String]) -> Void) {
        cancel()
        let requestID = UUID()
        activeRequestID = requestID
        self.completion = completion
        pendingRequests = [
            ("original", configuration.sourceLogoURL),
            ("white", configuration.sourceLogoWhiteURL)
        ]
        resolvedLogos = [:]
        startNext(requestID: requestID)
    }

    func cancel() {
        activeRequestID = nil
        completion = nil
        pendingRequests.removeAll(keepingCapacity: false)
        resolvedLogos.removeAll(keepingCapacity: false)
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        sessionDelegate = nil
    }

    private func startNext(requestID: UUID) {
        guard activeRequestID == requestID else { return }
        guard !pendingRequests.isEmpty else {
            finish(requestID: requestID)
            return
        }

        let next = pendingRequests.removeFirst()
        var request = URLRequest(url: next.url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("image/png,image/jpeg", forHTTPHeaderField: "Accept")

        let delegate = LyricsShareEditorSessionDelegate(
            maximumBytes: Self.maximumBytes,
            oversizedResponseMessage: "歌词品牌 Logo 响应超过 8 MiB 限制。"
        ) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.activeRequestID == requestID else { return }
                self.task = nil
                self.session?.finishTasksAndInvalidate()
                self.session = nil
                self.sessionDelegate = nil
                if error == nil,
                   let http = response as? HTTPURLResponse,
                   http.url == next.url,
                   (200..<300).contains(http.statusCode),
                   let mimeType = http.mimeType?.lowercased(),
                   let dataURL = Self.validatedDataURL(data, mimeType: mimeType) {
                    self.resolvedLogos[next.variant] = dataURL
                }
                self.startNext(requestID: requestID)
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        sessionDelegate = delegate
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    private func finish(requestID: UUID) {
        guard activeRequestID == requestID else { return }
        let completion = self.completion
        let logos = resolvedLogos
        activeRequestID = nil
        self.completion = nil
        pendingRequests.removeAll(keepingCapacity: false)
        resolvedLogos.removeAll(keepingCapacity: false)
        completion?(logos)
    }

    private static func validatedDataURL(_ data: Data, mimeType: String) -> String? {
        guard mimeType == "image/png" || mimeType == "image/jpeg",
              !data.isEmpty, data.count <= maximumBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0,
              width <= maximumDimension, height <= maximumDimension,
              width <= maximumPixels / height else {
            return nil
        }
        return "data:\(mimeType);base64,\(data.base64EncodedString())"
    }
}
