#if MITM_MOTION_ARTWORK_DIAGNOSTICS
import ObjectiveC.runtime
import UIKit

private final class MotionArtworkDiagnosticsTimerTarget: NSObject {
    @objc func tick() {
        MotionArtworkAlbumPageDiagnostics.snapshotIfChanged(reason: "timer")
    }
}

enum MotionArtworkAlbumPageDiagnostics {
    private static let timerTarget = MotionArtworkDiagnosticsTimerTarget()
    private static var timer: Timer?
    private static var lastSignature = ""

    static func start() {
        precondition(Thread.isMainThread)
        guard timer == nil else { return }
        NSLog("[MITMMotionProbe] diagnostics started")
        snapshotIfChanged(reason: "startup")
        timer = Timer.scheduledTimer(
            timeInterval: 2,
            target: timerTarget,
            selector: #selector(MotionArtworkDiagnosticsTimerTarget.tick),
            userInfo: nil,
            repeats: true
        )
    }

    fileprivate static func snapshotIfChanged(reason: String) {
        precondition(Thread.isMainThread)
        guard let controller = topController() else { return }

        var candidates = [UIImageView]()
        var budget = 1_200
        collectImageViews(in: controller.viewIfLoaded, budget: &budget, into: &candidates)
        candidates.sort { visibleArea($0) > visibleArea($1) }
        candidates = Array(candidates.prefix(12))

        let signatureParts = [String(describing: type(of: controller))]
            + candidates.map { candidate in
                let frame = candidate.convert(candidate.bounds, to: candidate.window)
                return "\(ObjectIdentifier(candidate)):\(format(frame)):\(nearbyText(for: candidate))"
            }
        let signature = signatureParts.joined(separator: "|")
        guard signature != lastSignature else { return }
        lastSignature = signature

        NSLog(
            "[MITMMotionProbe] begin reason=%@ top=%@ candidates=%d",
            reason,
            controllerChain(from: controller),
            candidates.count
        )
        for (index, imageView) in candidates.enumerated() {
            let imageSize = imageView.image.map { format(CGRect(origin: .zero, size: $0.size)) } ?? "none"
            NSLog(
                "[MITMMotionProbe] image[%d] class=%@ frame=%@ image=%@ mode=%ld a11y=%@ text=%@",
                index,
                String(describing: type(of: imageView)),
                format(imageView.convert(imageView.bounds, to: imageView.window)),
                imageSize,
                imageView.contentMode.rawValue,
                compact([imageView.accessibilityIdentifier, imageView.accessibilityLabel]
                    .compactMap { $0 }.joined(separator: " | "), limit: 240),
                nearbyText(for: imageView)
            )
            NSLog("[MITMMotionProbe] image[%d] superviews=%@", index, superviewChain(from: imageView))
            NSLog("[MITMMotionProbe] image[%d] responders=%@", index, responderChain(from: imageView))
            NSLog("[MITMMotionProbe] image[%d] methods=%@", index, relevantMethods(from: imageView))
        }
        NSLog("[MITMMotionProbe] end")
    }

    private static func topController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        var controller = windows.first(where: { $0.isKeyWindow })?.rootViewController
            ?? windows.first(where: { !$0.isHidden })?.rootViewController
            ?? UIApplication.shared.windows.first(where: { $0.isKeyWindow })?.rootViewController
        var seen = Set<ObjectIdentifier>()
        while let current = controller, seen.insert(ObjectIdentifier(current)).inserted {
            if let presented = current.presentedViewController {
                controller = presented
            } else if let navigation = current as? UINavigationController {
                controller = navigation.visibleViewController
            } else if let tabs = current as? UITabBarController {
                controller = tabs.selectedViewController
            } else if let visibleChild = current.children.last(where: { child in
                child.viewIfLoaded?.window != nil && !child.view.isHidden
            }) {
                controller = visibleChild
            } else {
                break
            }
        }
        return controller
    }

    private static func collectImageViews(
        in view: UIView?,
        budget: inout Int,
        into result: inout [UIImageView]
    ) {
        guard let view, budget > 0 else { return }
        budget -= 1
        guard !view.isHidden, view.alpha > 0.01, view.window != nil else { return }
        if let imageView = view as? UIImageView,
           imageView.bounds.width >= 120,
           imageView.bounds.height >= 120,
           visibleArea(imageView) > 10_000 {
            result.append(imageView)
        }
        for child in view.subviews.prefix(120) {
            collectImageViews(in: child, budget: &budget, into: &result)
            if budget == 0 { break }
        }
    }

    private static func visibleArea(_ view: UIView) -> CGFloat {
        guard let window = view.window else { return 0 }
        let frame = view.convert(view.bounds, to: window).intersection(window.bounds)
        guard !frame.isNull else { return 0 }
        return frame.width * frame.height
    }

    private static func nearbyText(for imageView: UIImageView) -> String {
        var root: UIView = imageView
        for _ in 0 ..< 4 {
            guard let parent = root.superview else { break }
            root = parent
        }
        var texts = [String]()
        var budget = 220
        collectText(in: root, budget: &budget, into: &texts)
        return compact(Array(texts.prefix(24)).joined(separator: " | "), limit: 900)
    }

    private static func collectText(in view: UIView, budget: inout Int, into result: inout [String]) {
        guard budget > 0, !view.isHidden, view.alpha > 0.01 else { return }
        budget -= 1
        if let label = view as? UILabel, let text = label.text?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty {
            result.append(text)
        } else if let button = view as? UIButton,
                  let title = button.title(for: .normal)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !title.isEmpty {
            result.append(title)
        }
        for child in view.subviews.prefix(80) {
            collectText(in: child, budget: &budget, into: &result)
            if budget == 0 { break }
        }
    }

    private static func controllerChain(from controller: UIViewController) -> String {
        var parts = [String]()
        var current: UIViewController? = controller
        for _ in 0 ..< 16 {
            guard let value = current else { break }
            parts.append(String(describing: type(of: value)))
            current = value.parent
        }
        return parts.joined(separator: " <- ")
    }

    private static func superviewChain(from view: UIView) -> String {
        var parts = [String]()
        var current: UIView? = view
        for _ in 0 ..< 16 {
            guard let value = current else { break }
            parts.append(String(describing: type(of: value)))
            current = value.superview
        }
        return parts.joined(separator: " -> ")
    }

    private static func responderChain(from responder: UIResponder) -> String {
        var parts = [String]()
        var current: UIResponder? = responder
        for _ in 0 ..< 16 {
            guard let value = current else { break }
            parts.append(String(describing: type(of: value)))
            current = value.next
        }
        return parts.joined(separator: " -> ")
    }

    private static func relevantMethods(from view: UIView) -> String {
        var classes = [AnyClass]()
        var responder: UIResponder? = view
        for _ in 0 ..< 12 {
            guard let value = responder else { break }
            let type: AnyClass = object_getClass(value)!
            if !classes.contains(where: { $0 === type }) { classes.append(type) }
            responder = value.next
        }

        let needles = ["album", "artist", "title", "uri", "model", "viewdid", "configure", "header"]
        var output = [String]()
        for cls in classes.prefix(8) {
            var count: UInt32 = 0
            guard let methods = class_copyMethodList(cls, &count) else { continue }
            defer { free(methods) }
            var matches = [String]()
            for index in 0 ..< min(Int(count), 500) {
                let method = methods[index]
                guard method_getNumberOfArguments(method) <= 3 else { continue }
                let name = NSStringFromSelector(method_getName(method))
                let lower = name.lowercased()
                if needles.contains(where: lower.contains) { matches.append(name) }
            }
            if !matches.isEmpty {
                output.append("\(NSStringFromClass(cls))={\(matches.prefix(30).joined(separator: ","))}")
            }
        }
        return compact(output.joined(separator: " | "), limit: 1_600)
    }

    private static func format(_ rect: CGRect) -> String {
        String(
            format: "%.1f,%.1f,%.1f,%.1f",
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height
        )
    }

    private static func compact(_ value: String, limit: Int) -> String {
        let text = value.replacingOccurrences(of: "[\\r\\n\\t]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "..."
    }
}
#endif
