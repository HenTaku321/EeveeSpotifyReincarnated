import Foundation
import Photos
import UIKit
import WebKit

final class LyricsShareEditorViewController: UIViewController, WKNavigationDelegate, LyricsShareEditorBridgeDelegate {
    private static let maximumDocumentBytes = 8 * 1024 * 1024

    private enum ProjectLoadResult {
        case missing
        case loaded(Data)
        case unreadable
    }

    private let webView: WKWebView
    private let bridge: LyricsShareEditorBridge
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var allowedReadDirectory: URL?
    private var documentLoaded = false
    private var requestTask: URLSessionDataTask?
    private var session: URLSession?
    private var sessionDelegate: LyricsShareEditorSessionDelegate?
    private var activeRequestID: UUID?
    private var projectTimer: Timer?
    private var projectWriteInFlight = false
    private var projectReady = false
    private var activeTrack: LyricsShareEditorTrack?
    private let artworkLoader = LyricsShareEditorArtworkLoader()
    private var exportInFlight = false
    private var isClosing = false
    private var closeAttemptID: UUID?
    private var hasReleasedWebView = false
    private var previousInteractivePopEnabled: Bool?

    init() {
        let bridge = LyricsShareEditorBridge(delegate: nil)
        let contentController = WKUserContentController()
        contentController.add(bridge, name: "shareEditor")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = contentController
        let nativeModeScript = """
        (() => {
          const hide = (selector) => {
            const element = document.querySelector(selector);
            if (element) {
              element.hidden = true;
              element.setAttribute('aria-hidden', 'true');
            }
          };
          hide('#load-button');
          hide('#project-menu-button');
          hide('#project-input');
          hide('label[for="project-input"]');
        })();
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: nativeModeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        self.bridge = bridge
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        bridge.delegate = self
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "歌词编辑器"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(closeEditor)
        )
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            image: UIImage(systemName: "gearshape"),
            style: .plain,
            target: self,
            action: #selector(configureLyricsService)
        )
        navigationItem.rightBarButtonItem?.accessibilityLabel = "歌词服务设置"

        webView.navigationDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        configureStatusView()
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        guard let indexURL = BundleHelper.shared.shareEditorIndexURL,
              let directoryURL = BundleHelper.shared.shareEditorDirectoryURL else {
            showError("编辑器资源未安装。请重新安装完整的歌词编辑器插件。")
            return
        }
        allowedReadDirectory = directoryURL.standardizedFileURL
        webView.loadFileURL(indexURL, allowingReadAccessTo: directoryURL)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if previousInteractivePopEnabled == nil {
            previousInteractivePopEnabled = navigationController?.interactivePopGestureRecognizer?.isEnabled
        }
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true else { return }
        if !isClosing {
            isClosing = true
            projectTimer?.invalidate()
            projectTimer = nil
            persistProject { [self] _ in finishExternalCleanup() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in
                finishExternalCleanup()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        if !isClosing { persistProject() }
        if let previousInteractivePopEnabled = previousInteractivePopEnabled {
            navigationController?.interactivePopGestureRecognizer?.isEnabled = previousInteractivePopEnabled
            self.previousInteractivePopEnabled = nil
        }
        super.viewWillDisappear(animated)
    }

    deinit {
        cancelNetworkAndReleaseWebView()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentLoaded = true
        beginTrackLoad()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError("编辑器页面加载失败：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.isFileURL,
              let root = allowedReadDirectory?.standardizedFileURL,
              url.standardizedFileURL.path.hasPrefix(root.path + "/") else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func lyricsShareEditorBridge(_ bridge: LyricsShareEditorBridge, didReceive scriptMessage: WKScriptMessage) {
        guard !isClosing, !hasReleasedWebView,
              scriptMessage.frameInfo.isMainFrame,
              let sourceWebView = scriptMessage.webView,
              sourceWebView === webView,
              let message = scriptMessage.body as? [String: Any],
              let command = message["command"] as? String else { return }

        switch command {
        case "close":
            closeEditor()
        case "exportPng":
            guard let action = message["action"] as? String,
                  action == "save" || action == "share",
                  let base64 = message["base64"] as? String else {
                presentNotice("导出请求格式无效。")
                return
            }
            let filename = message["suggestedFilename"] as? String ?? "lyrics-card.png"
            guard !exportInFlight else {
                presentNotice("已有 PNG 正在导出，请稍候。")
                return
            }
            exportInFlight = true
            exportPNG(base64: base64, suggestedFilename: filename, action: action)
        default:
            break
        }
    }

    @objc private func closeEditor() {
        guard !isClosing else { return }
        guard !exportInFlight else {
            presentNotice("PNG 正在导出，请完成导出后再关闭编辑器。")
            return
        }
        isClosing = true
        webView.isUserInteractionEnabled = false
        let attemptID = UUID()
        closeAttemptID = attemptID
        projectTimer?.invalidate()
        projectTimer = nil
        persistProject { [weak self] succeeded in
            if succeeded {
                self?.finishClosing(attemptID: attemptID)
            } else {
                self?.failClosing(attemptID: attemptID, "项目保存失败，编辑器没有关闭。请重试。")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.failClosing(attemptID: attemptID, "项目保存超时，编辑器没有关闭。请重试。")
        }
    }

    private func finishClosing(attemptID: UUID) {
        guard isClosing, closeAttemptID == attemptID, !hasReleasedWebView else { return }
        closeAttemptID = nil
        cancelNetworkAndReleaseWebView()
        if let navigationController = navigationController,
           navigationController.viewControllers.first === self,
           navigationController.presentingViewController != nil {
            navigationController.dismiss(animated: true)
        } else if let navigationController = navigationController,
                  navigationController.viewControllers.last === self {
            navigationController.popViewController(animated: true)
        } else {
            dismiss(animated: true)
        }
    }

    private func finishExternalCleanup() {
        guard isClosing, !hasReleasedWebView else { return }
        cancelNetworkAndReleaseWebView()
    }

    private func failClosing(attemptID: UUID, _ message: String) {
        guard isClosing, closeAttemptID == attemptID, !hasReleasedWebView else { return }
        isClosing = false
        closeAttemptID = nil
        webView.isUserInteractionEnabled = true
        if projectReady { startProjectPersistence() }
        presentNotice(message)
    }

    @objc private func retry() {
        hideError()
        beginTrackLoad()
    }

    @objc private func configureLyricsService() {
        LyricsEditorServiceConfigurationPresenter.present(from: self) { [weak self] in
            guard let self = self, !self.projectReady else { return }
            self.retry()
        }
    }

    private func configureStatusView() {
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.font = .preferredFont(forTextStyle: .body)

        retryButton.setTitle("重试", for: .normal)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [statusLabel, retryButton])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = UIView()
        container.backgroundColor = .systemBackground
        container.translatesAutoresizingMaskIntoConstraints = false
        container.isHidden = true
        container.addSubview(stack)
        view.addSubview(container)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: view.topAnchor),
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24)
        ])
        statusLabel.accessibilityIdentifier = "lyrics-share-editor-error"
        retryButton.accessibilityIdentifier = "lyrics-share-editor-retry"
        statusContainer = container
    }

    private var statusContainer: UIView?

    private func beginTrackLoad() {
        guard documentLoaded else { return }
        do {
            let candidate = try LyricsShareEditorTrackResolver.currentCandidate()
            if candidate.album.isEmpty {
                showStatus("当前播放器未提供专辑名，请补全后继续。", retryEnabled: false)
                promptForAlbum(candidate)
            } else {
                let track = try candidate.validated()
                LyricsShareEditorTrackResolver.remember(track)
                fetchLyrics(for: track)
            }
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func promptForAlbum(_ candidate: LyricsShareEditorTrackCandidate) {
        let alert = UIAlertController(
            title: "补全专辑名",
            message: "Spotify 当前播放器没有提供专辑名。填写专辑名后才能匹配 GitHub 歌词。",
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.placeholder = "专辑名"
            field.autocapitalizationType = .sentences
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.showError("未填写专辑名，无法载入歌词。")
        })
        alert.addAction(UIAlertAction(title: "继续", style: .default) { [weak self, weak alert] _ in
            guard let self = self else { return }
            let album = alert?.textFields?.first?.text ?? ""
            do {
                let track = try candidate.validated(albumOverride: album)
                LyricsShareEditorTrackResolver.remember(track)
                self.fetchLyrics(for: track)
            } catch {
                self.showError(error.localizedDescription)
            }
        })
        present(alert, animated: true)
    }

    private func fetchLyrics(for track: LyricsShareEditorTrack) {
        artworkLoader.cancel()
        requestTask?.cancel()
        session?.invalidateAndCancel()
        sessionDelegate = nil
        activeRequestID = nil
        projectReady = false
        activeTrack = track
        showStatus("正在读取 GitHub 歌词…", retryEnabled: false)

        let configuration: LyricsShareEditorConfiguration
        do {
            configuration = try .current()
        } catch {
            showError(error.localizedDescription)
            return
        }

        var request = URLRequest(url: configuration.endpointURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.token.isEmpty {
            request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
        }

        do {
            request.httpBody = try JSONEncoder().encode(LyricsShareEditorLyricsRequest(track: track))
        } catch {
            showError("无法编码当前曲目请求。")
            return
        }

        let requestID = UUID()
        let delegate = LyricsShareEditorSessionDelegate(maximumBytes: Self.maximumDocumentBytes) {
            [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.finishLyricsRequest(
                    requestID: requestID,
                    track: track,
                    data: data,
                    response: response,
                    error: error
                )
            }
        }
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        activeRequestID = requestID
        sessionDelegate = delegate
        self.session = session
        requestTask = session.dataTask(with: request)
        requestTask?.resume()
    }

    private func finishLyricsRequest(requestID: UUID, track: LyricsShareEditorTrack, data: Data,
                                     response: URLResponse?, error: Error?) {
        guard activeRequestID == requestID else { return }
        activeRequestID = nil
        requestTask = nil
        session?.finishTasksAndInvalidate()
        session = nil
        sessionDelegate = nil

        if let error = error as NSError?, error.code == NSURLErrorCancelled { return }
        if let error = error {
            showError(error is LyricsShareEditorError
                ? error.localizedDescription
                : "歌词服务请求失败：\(error.localizedDescription)")
            return
        }
        guard let http = response as? HTTPURLResponse else {
            showError("歌词服务响应无效。")
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["reason"] as? String
            showError(reason == "not-found" ? "GitHub 缓存中没有当前曲目的歌词。" : "歌词服务返回 HTTP \(http.statusCode)。")
            return
        }
        do {
            guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["ok"] as? Bool == true,
                  let returnedTrack = object["track"] as? [String: Any],
                  let returnedTrackID = returnedTrack["trackId"] as? String,
                  returnedTrackID.trimmingCharacters(in: .whitespacesAndNewlines) == track.trackId,
                  matchesIdentity(returnedTrack["title"], track.title),
                  matchesIdentity(returnedTrack["artist"], track.artist),
                  matchesIdentity(returnedTrack["album"], track.album) else {
                throw LyricsShareEditorError.invalidResponse("歌词服务返回的曲目身份与当前歌曲不一致。")
            }
            if let artworkDataURL = LyricsShareEditorTrackResolver.currentArtworkDataURL(matching: track) {
                try finishLyricsDocument(object, track: track, artworkDataURL: artworkDataURL)
                return
            }
            let remoteURL = LyricsShareEditorTrackResolver.currentArtworkRemoteURL(matching: track)
            showStatus("正在读取专辑封面…", retryEnabled: false)
            artworkLoader.resolve(track: track, preferredURL: remoteURL) { [weak self] artworkDataURL in
                guard let self = self,
                      !self.isClosing, !self.hasReleasedWebView,
                      self.activeTrack?.trackId == track.trackId else { return }
                do {
                    try self.finishLyricsDocument(object, track: track, artworkDataURL: artworkDataURL)
                } catch {
                    self.showError(error.localizedDescription)
                }
            }
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func finishLyricsDocument(_ source: [String: Any], track: LyricsShareEditorTrack,
                                      artworkDataURL: String?) throws {
        var object = source
        var trackObject: [String: Any] = [
            "trackId": track.trackId,
            "title": track.title,
            "artist": track.artist,
            "album": track.album
        ]
        if let artworkDataURL = artworkDataURL {
            trackObject["coverUrl"] = artworkDataURL
            object["track"] = trackObject
            if let encodedDocument = try? JSONSerialization.data(withJSONObject: object),
               encodedDocument.count > Self.maximumDocumentBytes {
                trackObject.removeValue(forKey: "coverUrl")
            }
        }
        object["track"] = trackObject
        try injectDocument(object)
    }

    private func matchesIdentity(_ value: Any?, _ expected: String) -> Bool {
        guard let value = value as? String else { return false }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).compare(
            expected.trimmingCharacters(in: .whitespacesAndNewlines),
            options: [.caseInsensitive, .diacriticInsensitive]
        ) == .orderedSame
    }

    private func injectDocument(_ document: [String: Any]) throws {
        guard JSONSerialization.isValidJSONObject(document) else {
            throw LyricsShareEditorError.invalidResponse("歌词文档不是有效 JSON。")
        }
        let data = try JSONSerialization.data(withJSONObject: document, options: [])
        guard data.count <= Self.maximumDocumentBytes else {
            throw LyricsShareEditorError.invalidResponse("歌词文档超过大小限制。")
        }
        let encoded = data.base64EncodedString()
        let projectScript: String
        var preservedProjectName: String?
        switch loadProject(for: activeTrack?.trackId) {
        case .loaded(let project):
            let projectEncoded = project.base64EncodedString()
            projectScript = """
            try {
              const project = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
                Uint8Array.from(atob('\(projectEncoded)'), character => character.charCodeAt(0))
              ));
              if (editorDocument.track && editorDocument.track.coverUrl
                  && project.document && project.document.track
                  && project.document.track.trackId === editorDocument.track.trackId) {
                project.document.track.coverUrl = editorDocument.track.coverUrl;
              }
              window.ShareEditor.restoreState(project);
            } catch (error) {
              projectRestored = false;
              projectError = String(error && error.message ? error.message : error);
            }
            """
        case .unreadable:
            guard let trackID = activeTrack?.trackId,
                  let backupName = Self.preserveUnreadableProject(trackID: trackID) else {
                throw LyricsShareEditorError.invalidResponse("保存的编辑项目无法读取，且无法安全备份；原项目没有被覆盖。")
            }
            preservedProjectName = backupName
            projectScript = ""
        case .missing:
            projectScript = ""
        }
        let script = """
        (() => {
          const bytes = Uint8Array.from(atob('\(encoded)'), character => character.charCodeAt(0));
          if (!window.ShareEditor) return false;
          const editorDocument = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          window.ShareEditor.loadDocument(editorDocument);
          let projectRestored = true;
          let projectError = '';
          \(projectScript)
          return { loaded: true, projectRestored, projectError };
        })();
        """
        webView.evaluateJavaScript(script) { [weak self] value, error in
            guard let self = self else { return }
            if let error = error {
                self.showError("歌词文档注入失败：\(error.localizedDescription)")
                return
            }
            guard let result = value as? [String: Any], result["loaded"] as? Bool == true else {
                self.showError("歌词编辑器没有接受文档。")
                return
            }
            if result["projectRestored"] as? Bool == false {
                guard let trackID = self.activeTrack?.trackId,
                      let backupName = Self.preserveUnreadableProject(trackID: trackID) else {
                    self.showError("保存的编辑项目无法恢复，且无法安全备份；原项目没有被覆盖。")
                    return
                }
                let detail = result["projectError"] as? String ?? "未知格式错误"
                writeDebugLog("[ShareEditor] project restore failed and was preserved: \(detail)")
                self.presentNotice("旧项目无法恢复，已保留为 \(backupName)。编辑器已从 GitHub 歌词重新开始。")
            } else if let backupName = preservedProjectName {
                self.presentNotice("旧项目无法读取，已保留为 \(backupName)。编辑器已从 GitHub 歌词重新开始。")
            }
            self.projectReady = true
            self.hideError()
            self.startProjectPersistence()
        }
    }

    private func startProjectPersistence() {
        projectTimer?.invalidate()
        projectTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.persistProject()
        }
    }

    private func persistProject(completion: ((Bool) -> Void)? = nil) {
        guard projectReady, let trackID = activeTrack?.trackId else {
            completion?(true)
            return
        }
        if projectWriteInFlight {
            if let completion = completion {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    self?.persistProject(completion: completion)
                }
            }
            return
        }
        projectWriteInFlight = true
        webView.evaluateJavaScript("window.ShareEditor && window.ShareEditor.serializeState();") { [weak self] value, error in
            guard let self = self else { return }
            if let error = error {
                self.projectWriteInFlight = false
                writeDebugLog("[ShareEditor] project serialization failed: \(error.localizedDescription)")
                completion?(false)
                return
            }
            guard let serialized = value as? String,
                  let data = serialized.data(using: .utf8),
                  data.count <= 32 * 1024 * 1024 else {
                self.projectWriteInFlight = false
                writeDebugLog("[ShareEditor] project serialization returned invalid data")
                completion?(false)
                return
            }
            DispatchQueue.global(qos: .utility).async {
                let succeeded: Bool
                do {
                    try Self.writeProjectAtomically(data, trackID: trackID)
                    succeeded = true
                } catch {
                    succeeded = false
                    writeDebugLog("[ShareEditor] project persistence failed: \(error.localizedDescription)")
                }
                DispatchQueue.main.async {
                    self.projectWriteInFlight = false
                    completion?(succeeded)
                }
            }
        }
    }

    private func loadProject(for trackID: String?) -> ProjectLoadResult {
        guard let trackID = trackID,
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return .missing
        }
        let url = documents
            .appendingPathComponent("ShareEditor", isDirectory: true)
            .appendingPathComponent("Projects", isDirectory: true)
            .appendingPathComponent(Self.safeProjectFilename(trackID), isDirectory: false)
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              let fileSize = values.fileSize,
              fileSize <= 32 * 1024 * 1024,
              let data = try? Data(contentsOf: url), data.count <= 32 * 1024 * 1024,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["version"] as? Int == 1,
              let document = root["document"] as? [String: Any],
              let track = document["track"] as? [String: Any],
              track["trackId"] as? String == trackID else { return .unreadable }
        return .loaded(data)
    }

    private static func writeProjectAtomically(_ data: Data, trackID: String) throws {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw LyricsShareEditorError.export("无法定位应用 Documents 目录。")
        }
        let directory = documents
            .appendingPathComponent("ShareEditor", isDirectory: true)
            .appendingPathComponent("Projects", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent(safeProjectFilename(trackID)), options: .atomic)
    }

    private static func preserveUnreadableProject(trackID: String) -> String? {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let directory = documents
            .appendingPathComponent("ShareEditor", isDirectory: true)
            .appendingPathComponent("Projects", isDirectory: true)
        let source = directory.appendingPathComponent(safeProjectFilename(trackID), isDirectory: false)
        guard FileManager.default.fileExists(atPath: source.path) else { return nil }
        let backupName = source.lastPathComponent + ".unreadable-" + UUID().uuidString
        do {
            try FileManager.default.moveItem(
                at: source,
                to: directory.appendingPathComponent(backupName, isDirectory: false)
            )
            return backupName
        } catch {
            writeDebugLog("[ShareEditor] failed to preserve unreadable project: \(error.localizedDescription)")
            return nil
        }
    }

    private static func safeProjectFilename(_ trackID: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let value = trackID.unicodeScalars.map { allowed.contains($0) ? String($0) : "-" }.joined()
        return String(value.prefix(100)) + ".lyrics-card.json"
    }

    private func exportPNG(base64: String, suggestedFilename: String, action: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let png = try LyricsShareEditorPNG.decode(base64: base64, suggestedFilename: suggestedFilename)
                if action == "save" {
                    DispatchQueue.main.async {
                        guard let self = self else { return }
                        guard !self.isClosing, !self.hasReleasedWebView else {
                            self.exportInFlight = false
                            return
                        }
                        self.saveToPhotoLibrary(png)
                    }
                    return
                }
                let url = try Self.writeAtomically(png.data, filename: png.filename)
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.exportInFlight = false
                    guard !self.isClosing, !self.hasReleasedWebView else { return }
                    self.presentShareSheet(for: url)
                }
            } catch {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.exportInFlight = false
                    guard !self.isClosing, !self.hasReleasedWebView else { return }
                    self.presentNotice("导出失败：\(error.localizedDescription)")
                }
            }
        }
    }

    private func saveToPhotoLibrary(_ png: LyricsShareEditorPNG) {
        let save = { [weak self] in
            guard let self = self else { return }
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = png.filename
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: png.data, options: options)
            }) { [weak self] succeeded, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.exportInFlight = false
                    guard !self.isClosing, !self.hasReleasedWebView else { return }
                    if succeeded {
                        self.presentNotice("PNG 已保存到系统图库。")
                    } else {
                        self.presentNotice("保存到系统图库失败：\(error?.localizedDescription ?? "未知错误")")
                    }
                }
            }
        }

        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited:
            save()
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if status == .authorized || status == .limited {
                        save()
                    } else {
                        self.exportInFlight = false
                        guard !self.isClosing, !self.hasReleasedWebView else { return }
                        self.presentNotice("没有系统图库写入权限，请在 iOS 设置中允许 Spotify 添加照片。")
                    }
                }
            }
        case .denied, .restricted:
            exportInFlight = false
            presentNotice("没有系统图库写入权限，请在 iOS 设置中允许 Spotify 添加照片。")
        @unknown default:
            exportInFlight = false
            presentNotice("无法确认系统图库写入权限。")
        }
    }

    private static func writeAtomically(_ data: Data, filename: String) throws -> URL {
        let fileManager = FileManager.default
        guard let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw LyricsShareEditorError.export("无法定位应用 Documents 目录。")
        }
        let exports = documents.appendingPathComponent("Exports", isDirectory: true)
        try fileManager.createDirectory(at: exports, withIntermediateDirectories: true)
        let destination = exports.appendingPathComponent(filename, isDirectory: false)
        try data.write(to: destination, options: .atomic)
        return destination
    }

    private func presentShareSheet(for url: URL) {
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        }
        present(activity, animated: true)
    }

    private func presentNotice(_ message: String) {
        let alert = UIAlertController(title: "歌词编辑器", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "确定", style: .default))
        present(alert, animated: true)
    }

    private func showError(_ message: String) {
        showStatus(message, retryEnabled: true)
    }

    private func showStatus(_ message: String, retryEnabled: Bool) {
        statusLabel.text = message
        retryButton.isHidden = !retryEnabled
        statusContainer?.isHidden = false
    }

    private func hideError() {
        statusContainer?.isHidden = true
    }

    private func cancelNetworkAndReleaseWebView() {
        guard !hasReleasedWebView else { return }
        hasReleasedWebView = true
        projectTimer?.invalidate()
        projectTimer = nil
        artworkLoader.cancel()
        requestTask?.cancel()
        requestTask = nil
        session?.invalidateAndCancel()
        session = nil
        sessionDelegate = nil
        activeRequestID = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "shareEditor")
        bridge.delegate = nil
        projectReady = false
        activeTrack = nil
        exportInFlight = false
        documentLoaded = false
    }
}
