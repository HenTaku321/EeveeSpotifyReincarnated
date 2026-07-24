import ObjectiveC.runtime
import Orion
import UIKit

struct LyricsEditorCardEntryGroup: HookGroup {}
struct LyricsEditorFullscreenEntryGroup: HookGroup {}
struct LyricsEditorSingalongEntryGroup: HookGroup {}

private var lyricsCardEntryAssociationKey: UInt8 = 0
private var lyricsCardEntryRetryAssociationKey: UInt8 = 0
private var lyricsFullscreenEntryAssociationKey: UInt8 = 0

private struct LyricsHeaderButtonStyle {
    let size: CGSize
    let alpha: CGFloat
    let tintColor: UIColor?
    let backgroundColor: UIColor?
    let cornerRadius: CGFloat
    let clipsToBounds: Bool
    let contentEdgeInsets: UIEdgeInsets
    let imageEdgeInsets: UIEdgeInsets
    let adjustsImageWhenHighlighted: Bool
    let showsTouchWhenHighlighted: Bool
    let symbolConfiguration: UIImage.SymbolConfiguration?
    let contentHorizontalAlignment: UIControl.ContentHorizontalAlignment
    let contentVerticalAlignment: UIControl.ContentVerticalAlignment
}

private final class LyricsCardEntryRetryState: NSObject {
    weak var header: UIView?
    var remainingAttempts = 8
    var isScheduled = false
    var didLogExhaustion = false

    init(header: UIView) {
        self.header = header
    }
}

private final class LyricsEditorEntryButton: UIButton {
    private let handler: () -> Void

    init(symbol: String, accessibilityLabel: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)

        translatesAutoresizingMaskIntoConstraints = false
        setImage(UIImage(systemName: symbol), for: .normal)
        self.accessibilityLabel = accessibilityLabel
        accessibilityHint = "打开当前歌曲的\(accessibilityLabel)"
        addTarget(self, action: #selector(didTap), for: .touchUpInside)
    }

    func apply(headerStyle style: LyricsHeaderButtonStyle) {
        alpha = style.alpha
        tintColor = style.tintColor
        backgroundColor = style.backgroundColor
        layer.cornerRadius = style.cornerRadius
        clipsToBounds = style.clipsToBounds
        contentEdgeInsets = style.contentEdgeInsets
        imageEdgeInsets = style.imageEdgeInsets
        adjustsImageWhenHighlighted = style.adjustsImageWhenHighlighted
        showsTouchWhenHighlighted = style.showsTouchWhenHighlighted
        contentHorizontalAlignment = style.contentHorizontalAlignment
        contentVerticalAlignment = style.contentVerticalAlignment
        if let symbolConfiguration = style.symbolConfiguration {
            setPreferredSymbolConfiguration(symbolConfiguration, forImageIn: .normal)
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: style.size.width),
            heightAnchor.constraint(equalToConstant: style.size.height)
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
    static func attachCardEntries(to header: UIView) {
        guard objc_getAssociatedObject(header, &lyricsCardEntryAssociationKey) == nil else { return }
        guard let stack = cardHeaderStack(in: header) else {
            scheduleCardEntryRetry(for: header)
            return
        }
        stack.layoutIfNeeded()
        guard let headerStyle = headerButtonStyle(in: header, fallbackStack: stack) else {
            scheduleCardEntryRetry(for: header)
            return
        }

        let shareButton = makeButton(
            symbol: "square.and.arrow.up",
            label: "歌词分享卡片",
            sourceView: header,
            headerStyle: headerStyle,
            launch: LyricsShareEditorLauncher.present
        )
        let timelineButton = makeButton(
            symbol: "waveform",
            label: "歌词内容与时间轴",
            sourceView: header,
            headerStyle: headerStyle,
            launch: LyricsTimelineEditorLauncher.present
        )
        let previousCount = stack.arrangedSubviews.count
        stack.addArrangedSubview(shareButton)
        stack.addArrangedSubview(timelineButton)
        objc_setAssociatedObject(header, &lyricsCardEntryAssociationKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        objc_setAssociatedObject(header, &lyricsCardEntryRetryAssociationKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        writeDebugLog(
            "[LyricsEditor] card entries attached: arrangedSubviews \(previousCount)->\(stack.arrangedSubviews.count)"
        )
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
        headerStyle: LyricsHeaderButtonStyle? = nil,
        launch: @escaping (UIViewController) -> Void
    ) -> UIButton {
        let button = LyricsEditorEntryButton(symbol: symbol, accessibilityLabel: label) { [weak sourceView] in
            guard let sourceView = sourceView,
                  let viewController = WindowHelper.shared.viewController(for: sourceView) else {
                writeDebugLog("[LyricsEditor] entry has no owning view controller")
                return
            }
            launch(viewController)
        }
        if let headerStyle = headerStyle {
            button.apply(headerStyle: headerStyle)
        } else {
            button.sizeToFit()
        }
        return button
    }

    private static func cardHeaderStack(in header: UIView) -> UIStackView? {
        if let ivar = class_getInstanceVariable(type(of: header), "$__lazy_storage_$_stackView"),
           let stack = object_getIvar(header, ivar) as? UIStackView {
            return stack
        }
        return nil
    }

    private static func headerButtonStyle(
        in header: UIView,
        fallbackStack stack: UIStackView
    ) -> LyricsHeaderButtonStyle? {
        let preferredContainerIvars = [
            "$__lazy_storage_$_shareButtonContainerView",
            "$__lazy_storage_$_expandButtonContainerView",
            "$__lazy_storage_$_translationButtonContainerView",
            "$__lazy_storage_$_vocalRemovalButtonContainerView"
        ]
        for name in preferredContainerIvars {
            guard let ivar = class_getInstanceVariable(type(of: header), name),
                  let container = object_getIvar(header, ivar) as? UIView else { continue }
            container.layoutIfNeeded()
            if let style = style(from: container) { return style }
        }

        // Snapshot the official arranged subviews before adding either editor button.
        return stack.arrangedSubviews.compactMap { style(from: $0) }.first
    }

    private static func style(from container: UIView) -> LyricsHeaderButtonStyle? {
        let button = (container as? UIButton)
            ?? container.subviews.first(where: { $0 is UIButton }) as? UIButton
        guard let button = button else { return nil }

        let containerSize = container.bounds.size
        let buttonSize = button.bounds.size
        let size = containerSize.width > 0 && containerSize.height > 0 ? containerSize : buttonSize
        guard size.width > 0, size.height > 0 else { return nil }

        let styledView = button.backgroundColor == nil && button.layer.cornerRadius == 0
            ? container
            : button
        return LyricsHeaderButtonStyle(
            size: size,
            alpha: styledView.alpha,
            tintColor: button.tintColor,
            backgroundColor: styledView.backgroundColor,
            cornerRadius: styledView.layer.cornerRadius,
            clipsToBounds: styledView.clipsToBounds,
            contentEdgeInsets: button.contentEdgeInsets,
            imageEdgeInsets: button.imageEdgeInsets,
            adjustsImageWhenHighlighted: button.adjustsImageWhenHighlighted,
            showsTouchWhenHighlighted: button.showsTouchWhenHighlighted,
            symbolConfiguration: button.preferredSymbolConfigurationForImage(in: .normal),
            contentHorizontalAlignment: button.contentHorizontalAlignment,
            contentVerticalAlignment: button.contentVerticalAlignment
        )
    }

    private static func scheduleCardEntryRetry(for header: UIView) {
        guard header.window != nil else { return }
        let retry: LyricsCardEntryRetryState
        if let existing = objc_getAssociatedObject(header, &lyricsCardEntryRetryAssociationKey) as? LyricsCardEntryRetryState {
            retry = existing
        } else {
            retry = LyricsCardEntryRetryState(header: header)
            objc_setAssociatedObject(
                header,
                &lyricsCardEntryRetryAssociationKey,
                retry,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
        }
        guard !retry.isScheduled else { return }
        guard retry.remainingAttempts > 0 else {
            if !retry.didLogExhaustion {
                retry.didLogExhaustion = true
                writeDebugLog("[LyricsEditor] CardHeaderView stack unavailable after lifecycle retries")
            }
            return
        }
        retry.isScheduled = true
        retry.remainingAttempts -= 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak retry] in
            guard let retry = retry else { return }
            retry.isScheduled = false
            guard let header = retry.header, header.window != nil else { return }
            attachCardEntries(to: header)
        }
    }
}

class LyricsCardHeaderEditorEntryHook: ClassHook<UIView> {
    typealias Group = LyricsEditorCardEntryGroup
    static let targetName = "Lyrics_CardElementImpl.CardHeaderView"

    func didMoveToWindow() {
        orig.didMoveToWindow()
        guard target.window != nil else { return }
        LyricsEditorEntryInstaller.attachCardEntries(to: target)
    }

    func layoutSubviews() {
        orig.layoutSubviews()
        guard target.window != nil else { return }
        LyricsEditorEntryInstaller.attachCardEntries(to: target)
    }
}

class LyricsFullscreenEditorEntryHook: ClassHook<UIViewController> {
    typealias Group = LyricsEditorFullscreenEntryGroup
    static let targetName = "Lyrics_FullscreenElementPageImpl.FullscreenElementViewController"

    func viewDidAppear(_ animated: Bool) {
        orig.viewDidAppear(animated)
        LyricsEditorEntryInstaller.attachFullscreenEntries(to: target)
    }
}

class LyricsSingalongFullscreenEditorEntryHook: ClassHook<UIViewController> {
    typealias Group = LyricsEditorSingalongEntryGroup
    static let targetName = "Lyrics_FullscreenSingalongPageImpl.FullscreenElementViewController"

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
    let singalongClass = NSClassFromString(
        "Lyrics_FullscreenSingalongPageImpl.FullscreenElementViewController"
    )
    var activated = [String]()

    if let cardClass = cardClass,
       class_getInstanceMethod(cardClass, #selector(UIView.didMoveToWindow)) != nil,
       class_getInstanceMethod(cardClass, #selector(UIView.layoutSubviews)) != nil {
        LyricsEditorCardEntryGroup().activate()
        activated.append("card")
    } else {
        writeDebugLog("[LyricsEditor] skipped card entry hook: class/lifecycle mismatch")
    }

    if let fullscreenClass = fullscreenClass,
       class_getInstanceMethod(fullscreenClass, #selector(UIViewController.viewDidAppear(_:))) != nil {
        LyricsEditorFullscreenEntryGroup().activate()
        activated.append("fullscreen")
    } else {
        writeDebugLog("[LyricsEditor] skipped fullscreen entry hook: class/selector mismatch")
    }

    if let singalongClass = singalongClass,
       class_getInstanceMethod(singalongClass, #selector(UIViewController.viewDidAppear(_:))) != nil {
        LyricsEditorSingalongEntryGroup().activate()
        activated.append("singalong")
    } else {
        writeDebugLog("[LyricsEditor] skipped singalong entry hook: class/selector mismatch")
    }

    guard !activated.isEmpty else {
        writeDebugLog("[LyricsEditor] skipped entry hooks: Spotify 9.1.x class/selector mismatch")
        return
    }
    writeDebugLog("[LyricsEditor] entry hooks activated: \(activated.joined(separator: ","))")
}
