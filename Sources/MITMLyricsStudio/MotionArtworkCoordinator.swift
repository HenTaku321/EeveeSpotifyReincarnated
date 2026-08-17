import ObjectiveC.runtime
import UIKit

private var motionArtworkAttachmentKey: UInt8 = 0

private final class MotionArtworkAttachment: NSObject {
    let requestID = UUID()
    let identityKey: String
    var task: URLSessionDataTask?
    var playerView: MotionArtworkPlayerView?

    init(identityKey: String) {
        self.identityKey = identityKey
    }

    func stop() {
        task?.cancel()
        task = nil
        playerView?.stop()
        playerView?.removeFromSuperview()
        playerView = nil
    }

    deinit {
        stop()
    }
}

final class MotionArtworkCoordinator {
    static let shared = MotionArtworkCoordinator()

    private let client: MotionArtworkClient
    private let preferences: MotionArtworkPreferences

    init(
        client: MotionArtworkClient = .shared,
        preferences: MotionArtworkPreferences = .shared
    ) {
        self.client = client
        self.preferences = preferences
    }

    func apply(identity: MotionArtworkIdentity, to host: UIView) {
        precondition(Thread.isMainThread)
        guard preferences.globalEnabled else {
            remove(from: host)
            return
        }
        guard !preferences.isDisabled(identity) else {
            remove(from: host)
            return
        }

        if let existing = attachment(for: host), existing.identityKey == identity.key {
            return
        }
        remove(from: host)

        let attachment = MotionArtworkAttachment(identityKey: identity.key)
        let requestID = attachment.requestID
        objc_setAssociatedObject(
            host,
            &motionArtworkAttachmentKey,
            attachment,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        attachment.task = client.resolve(identity: identity) { [weak self, weak host, weak attachment] result in
            DispatchQueue.main.async {
                guard let self, let host, let attachment,
                      self.attachment(for: host) === attachment,
                      attachment.requestID == requestID,
                      attachment.identityKey == identity.key else { return }
                attachment.task = nil
                switch result {
                case let .success(resolution?):
                    let playerView = MotionArtworkPlayerView(mediaURL: resolution.mediaURL) { [weak self, weak host] in
                        guard let self, let host else { return }
                        self.remove(from: host)
                    }
                    playerView.frame = host.bounds
                    playerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                    host.clipsToBounds = true
                    host.addSubview(playerView)
                    attachment.playerView = playerView
                case .success(nil), .failure:
                    self.remove(from: host)
                }
            }
        }
    }

    func remove(from host: UIView) {
        precondition(Thread.isMainThread)
        attachment(for: host)?.stop()
        objc_setAssociatedObject(host, &motionArtworkAttachmentKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    private func attachment(for host: UIView) -> MotionArtworkAttachment? {
        objc_getAssociatedObject(host, &motionArtworkAttachmentKey) as? MotionArtworkAttachment
    }
}
