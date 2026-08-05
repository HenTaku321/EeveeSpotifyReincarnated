import Foundation

struct LyricsShareEditorConfiguration {
    static let endpointPath = "v1/share-editor/lyrics"
    static let editEndpointPath = "v1/lyrics/edit"
    static let lyricsStatusIndexEndpointPath = "v1/lyrics/status-index"
    static let translationModelsEndpointPath = "v1/translation/models"
    static let shareEditorTranslateEndpointPath = "v1/share-editor/translate"
    static let shareEditorValidateEndpointPath = "v1/share-editor/validate"
    static let segmentsEndpointPath = "v1/segments"
    static let sourceLogoEndpointPath = "share-editor/source-logo"

    let endpointURL: URL
    let editEndpointURL: URL
    let lyricsStatusIndexEndpointURL: URL
    let translationModelsEndpointURL: URL
    let shareEditorTranslateEndpointURL: URL
    let shareEditorValidateEndpointURL: URL
    let segmentsEndpointURL: URL
    let sourceLogoURL: URL
    let sourceLogoWhiteURL: URL
    let token: String

    static func current() throws -> LyricsShareEditorConfiguration {
        try validated(
            serverURL: UserDefaults.shareEditorServerURL,
            token: UserDefaults.shareEditorToken
        )
    }

    static func validated(serverURL: String, token rawToken: String) throws -> LyricsShareEditorConfiguration {
        let rawURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawURL.isEmpty else {
            throw LyricsShareEditorError.configuration("请先在歌词编辑器设置中填写歌词服务地址。")
        }

        guard var components = URLComponents(string: rawURL),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            throw LyricsShareEditorError.configuration("歌词服务地址必须是有效的 HTTP(S) 基础地址，且不能包含账号、查询参数或片段。")
        }

        let isLoopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        if !token.isEmpty, scheme != "https", !isLoopback {
            throw LyricsShareEditorError.configuration("配置访问令牌时必须使用 HTTPS；只有本机 loopback 地址可使用 HTTP。")
        }
        guard token.utf8.count <= 4096,
              !token.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw LyricsShareEditorError.configuration("访问令牌不能超过 4096 bytes，且不能包含控制字符。")
        }

        components.scheme = scheme
        guard let baseURL = components.url else {
            throw LyricsShareEditorError.configuration("歌词服务地址无效。")
        }

        let sourceLogoURL = baseURL.appendingPathComponent(sourceLogoEndpointPath)
        var whiteComponents = URLComponents(url: sourceLogoURL, resolvingAgainstBaseURL: false)
        whiteComponents?.queryItems = [URLQueryItem(name: "variant", value: "white")]
        guard let sourceLogoWhiteURL = whiteComponents?.url else {
            throw LyricsShareEditorError.configuration("歌词服务地址无法生成 Logo 资源地址。")
        }

        return LyricsShareEditorConfiguration(
            endpointURL: baseURL.appendingPathComponent(endpointPath),
            editEndpointURL: baseURL.appendingPathComponent(editEndpointPath),
            lyricsStatusIndexEndpointURL: baseURL.appendingPathComponent(lyricsStatusIndexEndpointPath),
            translationModelsEndpointURL: baseURL.appendingPathComponent(translationModelsEndpointPath),
            shareEditorTranslateEndpointURL: baseURL.appendingPathComponent(shareEditorTranslateEndpointPath),
            shareEditorValidateEndpointURL: baseURL.appendingPathComponent(shareEditorValidateEndpointPath),
            segmentsEndpointURL: baseURL.appendingPathComponent(segmentsEndpointPath),
            sourceLogoURL: sourceLogoURL,
            sourceLogoWhiteURL: sourceLogoWhiteURL,
            token: token
        )
    }
}

extension UserDefaults {
    private static let shareEditorServerURLKey = "lyricsShareEditorServerURL"
    private static let shareEditorTokenKey = "lyricsShareEditorToken"

    static var shareEditorServerURL: String {
        get {
            #if MITM_LYRICS_STANDALONE
            return container.string(forKey: shareEditorServerURLKey) ?? "https://cpa.customdom.eu.org:7474"
            #else
            return container.string(forKey: shareEditorServerURLKey) ?? ""
            #endif
        }
        set { container.set(newValue, forKey: shareEditorServerURLKey) }
    }

    static var shareEditorToken: String {
        get { container.string(forKey: shareEditorTokenKey) ?? "" }
        set { container.set(newValue, forKey: shareEditorTokenKey) }
    }
}
