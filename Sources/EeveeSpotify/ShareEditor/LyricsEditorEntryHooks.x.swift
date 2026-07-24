import ObjectiveC.runtime
import Orion
import UIKit

struct LyricsEditorEntryGroup: HookGroup {}

private var lyricsCardEntryAssociationKey: UInt8 = 0
private var lyricsFullscreenEntryAssociationKey: UInt8 = 0

private final class LyricsEditorEntryButton: UIButton {
    private let handler: () -> Void

    init(symbol: String, accessibilityLabel: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)

        translatesAutoresizingMaskIntoConstraints = false
        let configuration = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        setImage(UIImage(systemName: symbol, withConfiguration: configuration), for: .normal)
        tintColor = .white
        backgroundColor = UIColor.black.withAlphaComponent(0.18)
        layer.cornerRadius = 16
        adjustsImageWhenHighlighted = true
        self.accessibilityLabel = accessibilityLabel
        accessibilityHint = "打开当前歌曲的\(accessibilityLabel)"
        addTarget(self, action: #selector(didTap), for: .touchUpInside)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 32),
            heightAnchor.constraint(equalToConstant: 32)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func didTap() {
        handler()
    }
}

private enum LyricsEditorEntryInstaller {
    static func attachCardEntries(to header: UIView, attempt: Int = 0) {
        guard objc_getAssociatedObject(header, &lyricsCardEntryAssociationKey) == nil else { return }
        guard let stack = cardHeaderStack(in: header) else {
            guard attempt < 5 else {
                writeDebugLog("[LyricsEditor] CardHeaderView stack unavailable")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                attachCardEntries(to: header, attempt: attempt + 1)
            }
            return
        }

        let shareButton = makeButton(
            symbol: "square.and.arrow.up",
            label: "歌词分享卡片",
            sourceView: header,
            launch: LyricsShareEditorLauncher.present
        )
        let timelineButton = makeButton(
            symbol: "waveform",
            label: "歌词内容与时间轴",
            sourceView: header,
            launch: LyricsTimelineEditorLauncher.present
        )
        stack.addArrangedSubview(shareButton)
        stack.addArrangedSubview(timelineButton)
        objc_setAssociatedObject(header, &lyricsCardEntryAssociationKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    static func attachFullscreenEntries(to controller: UIViewController) {
        guard objc_getAssociatedObject(controller, &lyricsFullscreenEntryAssociationKey) == nil else { return }

        let shareButton = makeButton(
            symbol: "square.and.arrow.up",
            label: "歌词分享卡片",
            sourceView: controller.view,
            launch: LyricsShareEditorLauncher.present
        )
        let timelineButton = makeButton(
            symbol: "waveform",
            label: "歌词内容与时间轴",
            sourceView: controller.view,
            launch: LyricsTimelineEditorLauncher.present
        )
        let existing = controller.navigationItem.rightBarButtonItems ?? []
        controller.navigationItem.rightBarButtonItems = existing + [
            UIBarButtonItem(customView: timelineButton),
            UIBarButtonItem(customView: shareButton)
        ]
        objc_setAssociatedObject(controller, &lyricsFullscreenEntryAssociationKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    private static func makeButton(
        symbol: String,
        label: String,
        sourceView: UIView,
        launch: @escaping (UIViewController) -> Void
    ) -> UIButton {
        LyricsEditorEntryButton(symbol: symbol, accessibilityLabel: label) { [weak sourceView] in
            guard let sourceView = sourceView,
                  let viewController = WindowHelper.shared.viewController(for: sourceView) else {
                writeDebugLog("[LyricsEditor] entry has no owning view controller")
                return
            }
            launch(viewController)
        }
    }

    private static func cardHeaderStack(in header: UIView) -> UIStackView? {
        if let ivar = class_getInstanceVariable(type(of: header), "$__lazy_storage_$_stackView"),
           let stack = object_getIvar(header, ivar) as? UIStackView {
            return stack
        }
        return nil
    }
}

class LyricsCardHeaderEditorEntryHook: ClassHook<UIView> {
    typealias Group = LyricsEditorEntryGroup
    static let targetName = "Lyrics_CardElementImpl.CardHeaderView"

    func initWithFrame(_ frame: CGRect) -> Target {
        let header = orig.initWithFrame(frame)
        DispatchQueue.main.async {
            LyricsEditorEntryInstaller.attachCardEntries(to: header)
        }
        return header
    }
}

class LyricsFullscreenEditorEntryHook: ClassHook<UIViewController> {
    typealias Group = LyricsEditorEntryGroup
    static let targetName = "Lyrics_FullscreenElementPageImpl.FullscreenElementViewController"

    func viewDidAppear(_ animated: Bool) {
        orig.viewDidAppear(animated)
        LyricsEditorEntryInstaller.attachFullscreenEntries(to: target)
    }
}

func activateLyricsEditorEntries() {
    let cardClass = NSClassFromString("Lyrics_CardElementImpl.CardHeaderView")
    let fullscreenClass = NSClassFromString(
        "Lyrics_FullscreenElementPageImpl.FullscreenElementViewController"
    )
    guard let cardClass = cardClass,
          class_getInstanceMethod(cardClass, Selector(("initWithFrame:"))) != nil,
          let fullscreenClass = fullscreenClass,
          class_getInstanceMethod(fullscreenClass, #selector(UIViewController.viewDidAppear(_:))) != nil else {
        writeDebugLog("[LyricsEditor] skipped entry hooks: Spotify 9.1.x class/selector mismatch")
        return
    }
    LyricsEditorEntryGroup().activate()
    writeDebugLog("[LyricsEditor] card and fullscreen entry hooks activated")
}
