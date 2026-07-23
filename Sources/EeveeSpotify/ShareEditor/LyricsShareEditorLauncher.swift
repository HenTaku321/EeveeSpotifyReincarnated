import SwiftUI
import UIKit

enum LyricsShareEditorLauncher {
    static func push(from navigationController: UINavigationController) {
        navigationController.pushViewController(LyricsShareEditorViewController(), animated: true)
    }
}

enum LyricsTimelineEditorLauncher {
    static func push(from navigationController: UINavigationController) {
        navigationController.pushViewController(LyricsTimelineEditorViewController(), animated: true)
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
