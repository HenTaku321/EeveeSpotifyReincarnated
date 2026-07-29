import Foundation
import UIKit
import WebKit

final class LyricsTimelineEditorViewController: UIViewController, WKNavigationDelegate, LyricsTimelineEditorBridgeDelegate {
    private enum DraftLoadResult {
        case missing
        case loaded(Data)
        case unreadable
    }

    private static let maximumDocumentBytes = 8 * 1024 * 1024
    private static let maximumDraftBytes = 8 * 1024 * 1024
    private static let draftVersion = 2

    private let webView: WKWebView
    private let bridge: LyricsTimelineEditorBridge
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let draftQueue = DispatchQueue(label: "com.eevee.lyrics.timeline-editor.draft", qos: .utility)
    private var statusContainer: UIView?
    private var allowedReadDirectory: URL?
    private var documentLoaded = false
    private var activeTrack: LyricsShareEditorTrack?
    private var activeHash = ""
    private var activeConfiguration: LyricsShareEditorConfiguration?
    private var requestTask: URLSessionDataTask?
    private var requestSession: URLSession?
    private var requestDelegate: LyricsShareEditorSessionDelegate?
    private var requestID: UUID?
    private var playerTimer: Timer?
    private var editorReady = false
    private var saveInFlight = false
    private var isClosing = false
    private var closeAttemptID: UUID?
    private var released = false
    private var previousInteractivePopEnabled: Bool?

    init() {
        let bridge = LyricsTimelineEditorBridge(delegate: nil)
        let contentController = WKUserContentController()
        contentController.add(bridge, name: "timelineEditor")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = contentController
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
        title = "歌词内容与时间轴"
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

        guard let indexURL = BundleHelper.shared.timelineEditorIndexURL,
              let directoryURL = BundleHelper.shared.timelineEditorDirectoryURL else {
            showError("时间轴编辑器资源未安装。请重新安装完整的歌词编辑器插件。")
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

    override func viewWillDisappear(_ animated: Bool) {
        if let previousInteractivePopEnabled = previousInteractivePopEnabled {
            navigationController?.interactivePopGestureRecognizer?.isEnabled = previousInteractivePopEnabled
            self.previousInteractivePopEnabled = nil
        }
        super.viewWillDisappear(animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true else { return }
        guard !released, !isClosing else { return }
        isClosing = true
        webView.isUserInteractionEnabled = false
        persistCurrentDraft { [self] _ in cleanup() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in cleanup() }
    }

    deinit { cleanup() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentLoaded = true
        beginTrackLoad()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError("时间轴编辑器页面加载失败：\(error.localizedDescription)")
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

    func lyricsTimelineEditorBridge(_ bridge: LyricsTimelineEditorBridge, didReceive scriptMessage: WKScriptMessage) {
        guard !released, !isClosing,
              scriptMessage.frameInfo.isMainFrame,
              scriptMessage.webView === webView,
              let message = scriptMessage.body as? [String: Any],
              let command = message["command"] as? String else { return }

        switch command {
        case "getPlayerState":
            pushPlayerSnapshot()
        case "seek":
            guard let track = activeTrack,
                  let value = message["positionMs"] as? NSNumber,
                  value.doubleValue.isFinite,
                  value.doubleValue >= 0,
                  value.doubleValue <= 86_400_000 else { return }
            let positionMs = Int(value.doubleValue.rounded())
            if !LyricsTimelinePlayerBridge.shared.seek(positionMs: positionMs, expectedTrackID: track.trackId) {
                presentNotice("当前播放器不支持跳转，或播放曲目已经变化。")
            }
            pushPlayerSnapshot()
        case "play":
            guard let track = activeTrack else { return }
            if !LyricsTimelinePlayerBridge.shared.play(expectedTrackID: track.trackId) {
                presentNotice("当前播放器未提供可用的播放接口。")
            }
            pushPlayerSnapshot()
        case "pause":
            guard let track = activeTrack else { return }
            if !LyricsTimelinePlayerBridge.shared.pause(expectedTrackID: track.trackId) {
                presentNotice("当前播放器未提供可用的暂停接口。")
            }
            pushPlayerSnapshot()
        case "draft":
            guard let serialized = message["serialized"] as? String else { return }
            persistDraft(serialized, completion: nil)
        case "save":
            guard !saveInFlight, let payload = message["payload"] as? [String: Any] else { return }
            save(payload: payload)
        default:
            break
        }
    }

    @objc private func retry() {
        hideError()
        beginTrackLoad()
    }

    @objc private func configureLyricsService() {
        LyricsEditorServiceConfigurationPresenter.present(from: self) { [weak self] in
            guard let self = self else { return }
            self.activeConfiguration = try? LyricsShareEditorConfiguration.current()
            if !self.editorReady { self.retry() }
        }
    }

    @objc private func closeEditor() {
        guard !isClosing else { return }
        guard !saveInFlight else {
            presentNotice("歌词正在保存，请等待服务器响应。")
            return
        }
        isClosing = true
        webView.isUserInteractionEnabled = false
        let attemptID = UUID()
        closeAttemptID = attemptID
        persistCurrentDraft { [weak self] succeeded in
            if succeeded {
                self?.finishClosing(attemptID: attemptID)
            } else {
                self?.failClosing(attemptID: attemptID, message: "草稿保存失败，编辑器没有关闭。请重试。")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.failClosing(attemptID: attemptID, message: "草稿保存超时，编辑器没有关闭。请重试。")
        }
    }

    private func finishClosing(attemptID: UUID) {
        guard isClosing, closeAttemptID == attemptID, !released else { return }
        closeAttemptID = nil
        cleanup()
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

    private func failClosing(attemptID: UUID, message: String) {
        guard isClosing, closeAttemptID == attemptID, !released else { return }
        isClosing = false
        closeAttemptID = nil
        webView.isUserInteractionEnabled = true
        presentNotice(message)
    }

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
            message: "填写专辑名后才能匹配 GitHub 歌词。",
            preferredStyle: .alert
        )
        alert.addTextField { $0.placeholder = "专辑名" }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.showError("未填写专辑名，无法载入歌词。")
        })
        alert.addAction(UIAlertAction(title: "继续", style: .default) { [weak self, weak alert] _ in
            guard let self = self else { return }
            do {
                let track = try candidate.validated(albumOverride: alert?.textFields?.first?.text)
                LyricsShareEditorTrackResolver.remember(track)
                self.fetchLyrics(for: track)
            } catch {
                self.showError(error.localizedDescription)
            }
        })
        present(alert, animated: true)
    }

    private func fetchLyrics(for track: LyricsShareEditorTrack) {
        do {
            let configuration = try LyricsShareEditorConfiguration.current()
            activeConfiguration = configuration
            activeTrack = track
            activeHash = ""
            editorReady = false
            showStatus("正在读取 GitHub 歌词…", retryEnabled: false)
            var request = URLRequest(url: configuration.endpointURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if !configuration.token.isEmpty {
                request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
            }
            request.httpBody = try JSONEncoder().encode(LyricsShareEditorLyricsRequest(track: track))
            perform(request: request) { [weak self] data, response, error in
                self?.finishLyricsLoad(track: track, data: data, response: response, error: error)
            }
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func finishLyricsLoad(track: LyricsShareEditorTrack, data: Data, response: URLResponse?, error: Error?) {
        if let error = error as NSError?, error.code == NSURLErrorCancelled { return }
        if let error = error {
            showError("歌词服务请求失败：\(error.localizedDescription)")
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
                  matchesTrack(returnedTrack, track),
                  let hash = object["hash"] as? String,
                  Self.isHash(hash),
                  object["lyrics"] is [String: Any] else {
                throw LyricsShareEditorError.invalidResponse("歌词服务返回的曲目、hash 或歌词正文无效。")
            }
            object["track"] = ["trackId": track.trackId, "title": track.title, "artist": track.artist, "album": track.album]
            activeHash = hash.lowercased()
            try inject(document: object, track: track)
        } catch {
            showError(error.localizedDescription)
        }
    }

    private func inject(document: [String: Any], track: LyricsShareEditorTrack) throws {
        let data = try Self.validatedJSONData(document, maximumBytes: Self.maximumDocumentBytes)
        let encoded = data.base64EncodedString()
        let draftScript: String
        var preservedUnreadableDraft = false
        switch loadDraft(trackID: track.trackId) {
        case .loaded(let draft):
            draftScript = """
            try {
              const draftBytes = Uint8Array.from(atob('\(draft.base64EncodedString())'), c => c.charCodeAt(0));
              window.LyricsTimelineEditor.restoreState(new TextDecoder('utf-8', { fatal: true }).decode(draftBytes));
            } catch (error) {
              return { loaded: true, draftRestored: false, draftError: String(error && error.message ? error.message : error) };
            }
            """
        case .unreadable:
            guard preserveUnreadableDraft(trackID: track.trackId) else {
                throw LyricsShareEditorError.invalidResponse("旧草稿无法读取，且无法安全备份；原草稿没有被覆盖。")
            }
            preservedUnreadableDraft = true
            draftScript = ""
        case .missing:
            draftScript = ""
        }
        let script = """
        (() => {
          if (!window.LyricsTimelineEditor) return { loaded: false };
          const bytes = Uint8Array.from(atob('\(encoded)'), c => c.charCodeAt(0));
          const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          window.LyricsTimelineEditor.loadDocument(document);
          \(draftScript)
          return { loaded: true, draftRestored: true };
        })();
        """
        webView.evaluateJavaScript(script) { [weak self] value, error in
            guard let self = self else { return }
            if let error = error {
                self.showError("歌词文档注入失败：\(error.localizedDescription)")
                return
            }
            guard let result = value as? [String: Any], result["loaded"] as? Bool == true else {
                self.showError("时间轴编辑器没有接受歌词文档。")
                return
            }
            if result["draftRestored"] as? Bool == false {
                let detail = result["draftError"] as? String ?? "unknown"
                writeDebugLog("[TimelineEditor] draft restore failed: \(detail)")
                guard self.preserveUnreadableDraft(trackID: track.trackId) else {
                    self.showError("旧草稿无法恢复，且无法安全备份；原草稿没有被覆盖。")
                    return
                }
                self.presentNotice("旧草稿无法恢复，已保留备份；编辑器从 GitHub 歌词重新开始。")
            } else if preservedUnreadableDraft {
                self.presentNotice("旧草稿无法读取，已保留备份；编辑器从 GitHub 歌词重新开始。")
            }
            self.hideError()
            self.editorReady = true
            self.startPlayerUpdates()
        }
    }

    private func save(payload: [String: Any]) {
        guard let track = activeTrack, let configuration = activeConfiguration else { return }
        do {
            guard editorReady,
                  let payloadTrack = payload["track"] as? [String: Any], matchesTrack(payloadTrack, track),
                  let hash = payload["hash"] as? String,
                  hash.lowercased() == activeHash,
                  Self.isHash(hash),
                  payload["lyrics"] is [String: Any] else {
                throw LyricsShareEditorError.invalidResponse("保存请求的曲目或原始 hash 与当前文档不一致。")
            }
            let body = try Self.validatedJSONData(payload, maximumBytes: Self.maximumDocumentBytes)
            var request = URLRequest(url: configuration.editEndpointURL)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if !configuration.token.isEmpty {
                request.setValue(configuration.token, forHTTPHeaderField: "X-MITM-Lyrics-Token")
            }
            request.httpBody = body
            saveInFlight = true
            perform(request: request) { [weak self] data, response, error in
                self?.finishSave(data: data, response: response, error: error)
            }
        } catch {
            sendSaveResult(ok: false, reason: error.localizedDescription, hash: nil)
        }
    }

    private func finishSave(data: Data, response: URLResponse?, error: Error?) {
        saveInFlight = false
        if let error = error {
            sendSaveResult(ok: false, reason: error.localizedDescription, hash: nil)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            sendSaveResult(ok: false, reason: "invalid-response", hash: nil)
            return
        }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(http.statusCode), object?["ok"] as? Bool == true else {
            sendSaveResult(ok: false, reason: object?["reason"] as? String ?? "HTTP \(http.statusCode)", hash: nil)
            return
        }
        let hash = (object?["hash"] as? String).flatMap { Self.isHash($0) ? $0.lowercased() : nil } ?? activeHash
        activeHash = hash
        sendSaveResult(ok: true, reason: nil, hash: hash)
    }

    private func perform(request: URLRequest, completion: @escaping (Data, URLResponse?, Error?) -> Void) {
        requestTask?.cancel()
        requestSession?.invalidateAndCancel()
        let id = UUID()
        requestID = id
        let delegate = LyricsShareEditorSessionDelegate(maximumBytes: Self.maximumDocumentBytes) {
            [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.requestID == id else { return }
                self.requestID = nil
                self.requestTask = nil
                self.requestSession?.finishTasksAndInvalidate()
                self.requestSession = nil
                self.requestDelegate = nil
                completion(data, response, error)
            }
        }
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        requestDelegate = delegate
        requestSession = session
        requestTask = session.dataTask(with: request)
        requestTask?.resume()
    }

    private func sendSaveResult(ok: Bool, reason: String?, hash: String?) {
        var result: [String: Any] = ["ok": ok]
        if let reason = reason { result["reason"] = reason }
        if let hash = hash { result["hash"] = hash }
        evaluate(function: "onSaveResult", object: result)
    }

    private func startPlayerUpdates() {
        playerTimer?.invalidate()
        playerTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.pushPlayerSnapshot()
        }
        pushPlayerSnapshot()
    }

    private func pushPlayerSnapshot() {
        guard activeTrack != nil else { return }
        evaluate(function: "onPlayerState", object: LyricsTimelinePlayerBridge.shared.snapshot().dictionary)
    }

    private func evaluate(function: String, object: [String: Any]) {
        guard !released, JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              data.count <= Self.maximumDocumentBytes else { return }
        let encoded = data.base64EncodedString()
        let script = """
        (() => {
          if (!window.LyricsTimelineEditor) return false;
          const bytes = Uint8Array.from(atob('\(encoded)'), c => c.charCodeAt(0));
          window.LyricsTimelineEditor.\(function)(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          return true;
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func persistCurrentDraft(completion: @escaping (Bool) -> Void) {
        guard editorReady, activeTrack != nil else { completion(true); return }
        webView.evaluateJavaScript("window.LyricsTimelineEditor && window.LyricsTimelineEditor.serializeState();") {
            [weak self] value, error in
            guard let self = self, error == nil, let serialized = value as? String else {
                completion(false)
                return
            }
            self.persistDraft(serialized, completion: completion)
        }
    }

    private func persistDraft(_ serialized: String, completion: ((Bool) -> Void)?) {
        guard let track = activeTrack,
              let data = serialized.data(using: .utf8),
              data.count <= Self.maximumDraftBytes,
              Self.validateDraft(data, trackID: track.trackId) else {
            completion?(false)
            return
        }
        draftQueue.async {
            let succeeded: Bool
            do {
                let url = try Self.draftURL(trackID: track.trackId, createDirectory: true)
                try data.write(to: url, options: .atomic)
                succeeded = true
            } catch {
                writeDebugLog("[TimelineEditor] draft write failed: \(error.localizedDescription)")
                succeeded = false
            }
            DispatchQueue.main.async { completion?(succeeded) }
        }
    }

    private func loadDraft(trackID: String) -> DraftLoadResult {
        guard let url = try? Self.draftURL(trackID: trackID, createDirectory: false),
              FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              let fileSize = values.fileSize,
              fileSize <= Self.maximumDraftBytes,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              data.count <= Self.maximumDraftBytes,
              Self.validateDraft(data, trackID: trackID) else { return .unreadable }
        return .loaded(data)
    }

    @discardableResult
    private func preserveUnreadableDraft(trackID: String) -> Bool {
        guard let source = try? Self.draftURL(trackID: trackID, createDirectory: false),
              FileManager.default.fileExists(atPath: source.path) else { return true }
        let destination = source.deletingPathExtension()
            .appendingPathExtension("unreadable-\(UUID().uuidString).json")
        do {
            try FileManager.default.moveItem(at: source, to: destination)
            return true
        } catch {
            writeDebugLog("[TimelineEditor] unreadable draft backup failed: \(error.localizedDescription)")
            return false
        }
    }

    private static func validateDraft(_ data: Data, trackID: String) -> Bool {
        guard let decoded = try? JSONSerialization.jsonObject(with: data),
              let object = decoded as? [String: Any],
              (object["version"] as? NSNumber)?.intValue == Self.draftVersion,
              let document = object["document"] as? [String: Any],
              let track = document["track"] as? [String: Any],
              track["trackId"] as? String == trackID else { return false }
        return true
    }

    private static func draftURL(trackID: String, createDirectory: Bool) throws -> URL {
        guard isTrackID(trackID),
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw LyricsShareEditorError.invalidResponse("无法确定歌词草稿目录。")
        }
        let directory = documents
            .appendingPathComponent("LyricsEditor", isDirectory: true)
            .appendingPathComponent("Projects", isDirectory: true)
        if createDirectory {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        return directory.appendingPathComponent(trackID, isDirectory: false).appendingPathExtension("lyrics.json")
    }

    private func matchesTrack(_ object: [String: Any], _ track: LyricsShareEditorTrack) -> Bool {
        guard object["trackId"] as? String == track.trackId else { return false }
        return matchesIdentity(object["title"], track.title)
            && matchesIdentity(object["artist"], track.artist)
            && matchesIdentity(object["album"], track.album)
    }

    private func matchesIdentity(_ value: Any?, _ expected: String) -> Bool {
        guard let value = value as? String else { return false }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).compare(
            expected.trimmingCharacters(in: .whitespacesAndNewlines),
            options: [.caseInsensitive, .diacriticInsensitive]
        ) == .orderedSame
    }

    private static func isHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 70) || ($0.value >= 97 && $0.value <= 102)
        }
    }

    private static func isTrackID(_ value: String) -> Bool {
        value.utf8.count == 22 && value.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122)
        }
    }

    private static func validatedJSONData(_ object: Any, maximumBytes: Int) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw LyricsShareEditorError.invalidResponse("歌词文档不是有效 JSON。")
        }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard data.count <= maximumBytes else {
            throw LyricsShareEditorError.invalidResponse("歌词文档超过 8 MiB 限制。")
        }
        return data
    }

    private func configureStatusView() {
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
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
        statusContainer = container
    }

    private func showStatus(_ message: String, retryEnabled: Bool) {
        statusLabel.text = message
        retryButton.isHidden = !retryEnabled
        statusContainer?.isHidden = false
        if let statusContainer = statusContainer { view.bringSubviewToFront(statusContainer) }
    }

    private func showError(_ message: String) { showStatus(message, retryEnabled: true) }
    private func hideError() { statusContainer?.isHidden = true }

    private func presentNotice(_ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "歌词编辑器", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        present(alert, animated: true)
    }

    private func cleanup() {
        guard !released else { return }
        released = true
        playerTimer?.invalidate()
        playerTimer = nil
        requestTask?.cancel()
        requestSession?.invalidateAndCancel()
        requestTask = nil
        requestSession = nil
        requestDelegate = nil
        requestID = nil
        closeAttemptID = nil
        bridge.delegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "timelineEditor")
        webView.navigationDelegate = nil
        webView.stopLoading()
        activeTrack = nil
        activeConfiguration = nil
        editorReady = false
    }
}
