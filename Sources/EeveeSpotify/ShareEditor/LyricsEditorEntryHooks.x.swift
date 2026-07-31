import ObjectiveC.runtime
import Orion
import UIKit

struct LyricsEditorCardEntryGroup: HookGroup {}
struct LyricsEditorFullscreenEntryGroup: HookGroup {}
struct LyricsEditorSingalongEntryGroup: HookGroup {}

private var lyricsCardEntryAssociationKey: UInt8 = 0
private var lyricsCardEntryRetryAssociationKey: UInt8 = 0
private var lyricsFullscreenEntryAssociationKey: UInt8 = 0
private var lyricsEditorCardEntryGroupActivated = false
private var lyricsEditorFullscreenEntryGroupActivated = false
private var lyricsEditorSingalongEntryGroupActivated = false

private enum LyricsEditorEntryIdentity {
    static let share = "mitm-lyrics-studio.share"
    static let timeline = "mitm-lyrics-studio.timeline"

    static func value(for label: String?) -> String? {
        switch label {
        case "歌词分享卡片": return share
        case "歌词内容与时间轴": return timeline
        default: return nil
        }
    }
}

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
        accessibilityIdentifier = LyricsEditorEntryIdentity.value(for: accessibilityLabel)
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
        guard let stack = cardHeaderStack(in: header) else {
            scheduleCardEntryRetry(for: header)
            return
        }
        guard objc_getAssociatedObject(header, &lyricsCardEntryAssociationKey) == nil else { return }
        if containsBothEntries(in: stack) {
            markCardEntriesAttached(to: header)
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
        markCardEntriesAttached(to: header)
        DispatchQueue.main.async { [weak stack] in
            if let stack = stack { deduplicateCardEntries(in: stack) }
        }
        writeDebugLog(
            "[LyricsEditor] card entries attached: arrangedSubviews \(previousCount)->\(stack.arrangedSubviews.count)"
        )
    }

    static func attachFullscreenEntries(to controller: UIViewController) {
        guard objc_getAssociatedObject(controller, &lyricsFullscreenEntryAssociationKey) == nil else { return }

        if containsBothEntries(in: controller.navigationItem.rightBarButtonItems ?? []) {
            objc_setAssociatedObject(controller, &lyricsFullscreenEntryAssociationKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            return
        }

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
        DispatchQueue.main.async { [weak controller] in
            guard let controller = controller else { return }
            controller.navigationItem.rightBarButtonItems = deduplicatedFullscreenEntries(
                controller.navigationItem.rightBarButtonItems ?? []
            )
        }
    }

    private static func markCardEntriesAttached(to header: UIView) {
        objc_setAssociatedObject(header, &lyricsCardEntryAssociationKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        objc_setAssociatedObject(header, &lyricsCardEntryRetryAssociationKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    private static func entryIdentity(in view: UIView) -> String? {
        if let button = view as? UIButton {
            return button.accessibilityIdentifier
                ?? LyricsEditorEntryIdentity.value(for: button.accessibilityLabel)
        }
        return view.subviews.lazy.compactMap(entryIdentity).first
    }

    private static func containsBothEntries(in view: UIView) -> Bool {
        let identities = Set(view.subviews.compactMap(entryIdentity))
        return identities.contains(LyricsEditorEntryIdentity.share)
            && identities.contains(LyricsEditorEntryIdentity.timeline)
    }

    private static func containsBothEntries(in items: [UIBarButtonItem]) -> Bool {
        let identities = Set(items.compactMap { $0.customView.flatMap(entryIdentity) })
        return identities.contains(LyricsEditorEntryIdentity.share)
            && identities.contains(LyricsEditorEntryIdentity.timeline)
    }

    private static func deduplicateCardEntries(in stack: UIStackView) {
        var seen = Set<String>()
        for view in stack.arrangedSubviews {
            guard let identity = entryIdentity(in: view) else { continue }
            if seen.insert(identity).inserted { continue }
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private static func deduplicatedFullscreenEntries(_ items: [UIBarButtonItem]) -> [UIBarButtonItem] {
        var seen = Set<String>()
        return items.filter { item in
            guard let identity = item.customView.flatMap(entryIdentity) else { return true }
            return seen.insert(identity).inserted
        }
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
        let preferredContainers = preferredContainerIvars.compactMap { name -> UIView? in
            guard let ivar = class_getInstanceVariable(type(of: header), name) else { return nil }
            return object_getIvar(header, ivar) as? UIView
        }
        let candidates = stack.arrangedSubviews + preferredContainers
        for container in candidates {
            container.layoutIfNeeded()
            if let style = style(from: container, limitingHeight: stack.bounds.height) { return style }
        }
        return nil
    }

    private static func descendantButton(in view: UIView) -> UIButton? {
        if let button = view as? UIButton { return button }
        for subview in view.subviews {
            if let button = descendantButton(in: subview) { return button }
        }
        return nil
    }

    private static func style(from container: UIView, limitingHeight: CGFloat) -> LyricsHeaderButtonStyle? {
        guard !container.isHidden, container.alpha > 0.01 else { return nil }
        guard let button = descendantButton(in: container),
              !button.isHidden,
              button.alpha > 0.01 else { return nil }

        let containerSize = container.bounds.size
        let buttonSize = button.bounds.size
        let measuredSize = containerSize.width > 0 && containerSize.height > 0 ? containerSize : buttonSize
        guard measuredSize.width > 0, measuredSize.height > 0 else { return nil }
        let measuredSide = min(measuredSize.width, measuredSize.height)
        let side = limitingHeight > 0 ? min(measuredSide, limitingHeight) : measuredSide
        guard side >= 20 else { return nil }
        let size = CGSize(width: side, height: side)

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

@discardableResult
func activateLyricsEditorEntries() -> Bool {
    let cardClass = NSClassFromString("Lyrics_CardElementImpl.CardHeaderView")
    let fullscreenClass = NSClassFromString(
        "Lyrics_FullscreenElementPageImpl.FullscreenElementViewController"
    )
    let singalongClass = NSClassFromString(
        "Lyrics_FullscreenSingalongPageImpl.FullscreenElementViewController"
    )
    var activated = [String]()

    if !lyricsEditorCardEntryGroupActivated {
        if let cardClass = cardClass,
           class_getInstanceMethod(cardClass, #selector(UIView.didMoveToWindow)) != nil,
           class_getInstanceMethod(cardClass, #selector(UIView.layoutSubviews)) != nil {
            LyricsEditorCardEntryGroup().activate()
            lyricsEditorCardEntryGroupActivated = true
            activated.append("card")
        } else {
            writeDebugLog("[LyricsEditor] skipped card entry hook: class/lifecycle mismatch")
        }
    }

    if !lyricsEditorFullscreenEntryGroupActivated {
        if let fullscreenClass = fullscreenClass,
           class_getInstanceMethod(fullscreenClass, #selector(UIViewController.viewDidAppear(_:))) != nil {
            LyricsEditorFullscreenEntryGroup().activate()
            lyricsEditorFullscreenEntryGroupActivated = true
            activated.append("fullscreen")
        } else {
            writeDebugLog("[LyricsEditor] skipped fullscreen entry hook: class/selector mismatch")
        }
    }

    if !lyricsEditorSingalongEntryGroupActivated {
        if let singalongClass = singalongClass,
           class_getInstanceMethod(singalongClass, #selector(UIViewController.viewDidAppear(_:))) != nil {
            LyricsEditorSingalongEntryGroup().activate()
            lyricsEditorSingalongEntryGroupActivated = true
            activated.append("singalong")
        } else {
            writeDebugLog("[LyricsEditor] skipped singalong entry hook: class/selector mismatch")
        }
    }

    if !activated.isEmpty {
        writeDebugLog("[LyricsEditor] entry hooks activated: \(activated.joined(separator: ","))")
    } else if !lyricsEditorCardEntryGroupActivated,
              !lyricsEditorFullscreenEntryGroupActivated,
              !lyricsEditorSingalongEntryGroupActivated {
        writeDebugLog("[LyricsEditor] skipped entry hooks: Spotify 9.1.x class/selector mismatch")
    }

    return lyricsEditorCardEntryGroupActivated
        && lyricsEditorFullscreenEntryGroupActivated
        && lyricsEditorSingalongEntryGroupActivated
}
