import SwiftUI
import UIKit

enum LyricsShareEditorLauncher {
    static func push(from navigationController: UINavigationController) {
        navigationController.pushViewController(LyricsShareEditorViewController(), animated: true)
    }

    static func present(from viewController: UIViewController) {
        LyricsEditorModalPresenter.present(LyricsShareEditorViewController(), from: viewController)
    }
}

enum LyricsTimelineEditorLauncher {
    static func push(from navigationController: UINavigationController) {
        navigationController.pushViewController(LyricsTimelineEditorViewController(), animated: true)
    }

    static func present(from viewController: UIViewController) {
        LyricsEditorModalPresenter.present(LyricsTimelineEditorViewController(), from: viewController)
    }
}

private enum LyricsEditorModalPresenter {
    static func present(_ editor: UIViewController, from source: UIViewController) {
        var presenter = source
        while let presented = presenter.presentedViewController {
            presenter = presented
        }
        let visible = (presenter as? UINavigationController)?.visibleViewController ?? presenter
        guard !(visible is LyricsShareEditorViewController),
              !(visible is LyricsTimelineEditorViewController) else { return }

        let navigationController = UINavigationController(rootViewController: editor)
        navigationController.modalPresentationStyle = .fullScreen
        navigationController.navigationBar.prefersLargeTitles = false
        presenter.present(navigationController, animated: true)
    }
}

enum LyricsEditorServiceConfigurationPresenter {
    static func present(from viewController: UIViewController, onSave: @escaping () -> Void) {
        guard viewController.presentedViewController == nil else { return }

        let alert = UIAlertController(
            title: "歌词服务",
            message: "访问令牌只会通过原生 HTTPS header 发送。",
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.placeholder = "https://lyrics.example.com"
            field.text = UserDefaults.shareEditorServerURL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.keyboardType = .URL
        }
        alert.addTextField { field in
            field.placeholder = "可选：X-MITM-Lyrics-Token"
            field.text = UserDefaults.shareEditorToken
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "保存", style: .default) { [weak alert, weak viewController] _ in
            let serverURL = alert?.textFields?.first?.text ?? ""
            let token = alert?.textFields?.dropFirst().first?.text ?? ""
            do {
                _ = try LyricsShareEditorConfiguration.validated(serverURL: serverURL, token: token)
                UserDefaults.shareEditorServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
                UserDefaults.shareEditorToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
                onSave()
            } catch {
                DispatchQueue.main.async {
                    guard let viewController = viewController,
                          viewController.presentedViewController == nil else { return }
                    let errorAlert = UIAlertController(
                        title: "配置无效",
                        message: error.localizedDescription,
                        preferredStyle: .alert
                    )
                    errorAlert.addAction(UIAlertAction(title: "好", style: .default))
                    viewController.present(errorAlert, animated: true)
                }
            }
        })
        viewController.present(alert, animated: true)
    }
}

struct EeveeShareEditorSettingsView: View {
    let navigationController: UINavigationController
    @State private var serverURL: String
    @State private var token: String

    init(navigationController: UINavigationController) {
        self.navigationController = navigationController
        _serverURL = State(initialValue: UserDefaults.shareEditorServerURL)
        _token = State(initialValue: UserDefaults.shareEditorToken)
    }

    var body: some View {
        List {
            Section(
                header: Text("歌词服务"),
                footer: Text("只在原生请求的 HTTP header 中使用令牌，不会放入编辑器 URL、网页存储或导出图片。")
            ) {
                TextField("https://lyrics.example.com", text: $serverURL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .keyboardType(.URL)
                SecureField("可选：X-MITM-Lyrics-Token", text: $token)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }

            Section(
                footer: Text("请先播放歌曲。编辑器会从当前播放器读取歌曲名、艺术家、专辑和 Spotify track ID，再读取 GitHub 歌词。编辑项目按曲目自动保存在 Documents/ShareEditor/Projects。")
            ) {
                Button {
                    saveConfiguration()
                    LyricsShareEditorLauncher.push(from: navigationController)
                } label: {
                    HStack {
                        Image(systemName: "music.note.list")
                        Text("打开歌词编辑器")
                    }
                }
                .disabled(serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .listStyle(GroupedListStyle())
        .onChange(of: serverURL) { _ in saveConfiguration() }
        .onChange(of: token) { _ in saveConfiguration() }
    }

    private func saveConfiguration() {
        UserDefaults.shareEditorServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.shareEditorToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct EeveeTimelineEditorSettingsView: View {
    let navigationController: UINavigationController
    @State private var serverURL: String
    @State private var token: String

    init(navigationController: UINavigationController) {
        self.navigationController = navigationController
        _serverURL = State(initialValue: UserDefaults.shareEditorServerURL)
        _token = State(initialValue: UserDefaults.shareEditorToken)
    }

    var body: some View {
        List {
            Section(
                header: Text("歌词服务"),
                footer: Text("使用当前曲目的 Spotify track ID 读取 GitHub 歌词；令牌只通过原生 HTTPS header 发送。")
            ) {
                TextField("https://lyrics.example.com", text: $serverURL)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
                    .keyboardType(.URL)
                SecureField("可选：X-MITM-Lyrics-Token", text: $token)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }
            Section(
                footer: Text("草稿按曲目保存在 Documents/LyricsEditor/Projects。保存按钮才会写回服务端；播放器不支持播放控制时仍可手动输入毫秒。")
            ) {
                Button {
                    saveConfiguration()
                    LyricsTimelineEditorLauncher.push(from: navigationController)
                } label: {
                    HStack {
                        Image(systemName: "waveform")
                        Text("打开歌词内容与时间轴")
                    }
                }
                .disabled(serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .listStyle(GroupedListStyle())
        .onChange(of: serverURL) { _ in saveConfiguration() }
        .onChange(of: token) { _ in saveConfiguration() }
    }

    private func saveConfiguration() {
        UserDefaults.shareEditorServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.shareEditorToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
