import Foundation

struct LyricsShareEditorConfiguration {
    static let endpointPath = "v1/share-editor/lyrics"
    static let editEndpointPath = "v1/lyrics/edit"

    let endpointURL: URL
    let editEndpointURL: URL
    let token: String

    static func current() throws -> LyricsShareEditorConfiguration {
        let rawURL = UserDefaults.shareEditorServerURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = UserDefaults.shareEditorToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawURL.isEmpty else {
            throw LyricsShareEditorError.configuration("请先在 EeveeSpotify 设置中填写歌词服务地址。")
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

        return LyricsShareEditorConfiguration(
            endpointURL: baseURL.appendingPathComponent(endpointPath),
            editEndpointURL: baseURL.appendingPathComponent(editEndpointPath),
            token: token
        )
    }
}

extension UserDefaults {
    private static let shareEditorServerURLKey = "lyricsShareEditorServerURL"
    private static let shareEditorTokenKey = "lyricsShareEditorToken"

    static var shareEditorServerURL: String {
        get { container.string(forKey: shareEditorServerURLKey) ?? "" }
        set { container.set(newValue, forKey: shareEditorServerURLKey) }
    }

    static var shareEditorToken: String {
        get { container.string(forKey: shareEditorTokenKey) ?? "" }
        set { container.set(newValue, forKey: shareEditorTokenKey) }
    }
}
