import Foundation

struct MotionArtworkResolution {
    let mediaURL: URL
    let previewURL: URL?
}

private struct MotionArtworkResolverPayload: Decodable {
    let ok: Bool
    let found: Bool
    let videoUrl: String?
    let hlsUrl: String?
    let previewFrameUrl: String?
}

final class MotionArtworkClient {
    static let shared = MotionArtworkClient()

    @discardableResult
    func resolve(
        identity: MotionArtworkIdentity,
        completion: @escaping (Result<MotionArtworkResolution?, Error>) -> Void
    ) -> URLSessionDataTask? {
        let configuration: LyricsShareEditorConfiguration
        do {
            configuration = try LyricsShareEditorConfiguration.current()
        } catch {
            completion(.failure(error))
            return nil
        }

        guard var components = URLComponents(
            url: configuration.appleMotionArtworkEndpointURL,
            resolvingAgainstBaseURL: false
        ) else {
            completion(.failure(MotionArtworkClientError.invalidEndpoint))
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "artist", value: identity.artist),
            URLQueryItem(name: "album", value: identity.album),
        ]
        guard let url = components.url else {
            completion(.failure(MotionArtworkClientError.invalidEndpoint))
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadRevalidatingCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.token.isEmpty {
            request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
        }

        var session: URLSession?
        let delegate = LyricsShareEditorSessionDelegate(
            maximumBytes: 128 * 1024,
            oversizedResponseMessage: "动态封面服务响应超过 128 KiB 限制。"
        ) { data, response, error in
            defer {
                session?.finishTasksAndInvalidate()
                session = nil
            }
            if let error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse,
                  (200 ... 299).contains(http.statusCode) else {
                completion(.failure(MotionArtworkClientError.invalidHTTPStatus))
                return
            }
            do {
                completion(.success(try Self.decode(data)))
            } catch {
                completion(.failure(error))
            }
        }
        let newSession = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        session = newSession
        let task = newSession.dataTask(with: request)
        task.resume()
        return task
    }

    private static func decode(_ data: Data) throws -> MotionArtworkResolution? {
        let payload = try JSONDecoder().decode(MotionArtworkResolverPayload.self, from: data)
        guard payload.ok else { throw MotionArtworkClientError.invalidPayload }
        guard payload.found else { return nil }

        let videoURL = allowedAppleURL(payload.videoUrl, expectedExtension: "mp4")
        let hlsURL = allowedAppleURL(payload.hlsUrl, expectedExtension: "m3u8")
        guard let mediaURL = videoURL ?? hlsURL else {
            throw MotionArtworkClientError.invalidMediaURL
        }
        return MotionArtworkResolution(
            mediaURL: mediaURL,
            previewURL: allowedPreviewURL(payload.previewFrameUrl)
        )
    }

    private static func allowedAppleURL(_ raw: String?, expectedExtension: String) -> URL? {
        guard let raw, let url = URL(string: raw), url.scheme == "https",
              url.user == nil, url.password == nil, url.port == nil,
              url.host?.lowercased() == "mvod.itunes.apple.com",
              url.pathExtension.lowercased() == expectedExtension else { return nil }
        return url
    }

    private static func allowedPreviewURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), url.scheme == "https",
              url.user == nil, url.password == nil, url.port == nil,
              let host = url.host?.lowercased(),
              host == "mzstatic.com" || host.hasSuffix(".mzstatic.com"),
              ["jpg", "jpeg", "png"].contains(url.pathExtension.lowercased()) else { return nil }
        return url
    }
}

private enum MotionArtworkClientError: Error {
    case invalidEndpoint
    case invalidHTTPStatus
    case invalidPayload
    case invalidMediaURL
}
