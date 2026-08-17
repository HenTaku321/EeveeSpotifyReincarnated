import AVFoundation
import UIKit

final class MotionArtworkPlayerView: UIView {
    private let queuePlayer: AVQueuePlayer
    private let playerLayer: AVPlayerLayer
    private var looper: AVPlayerLooper?
    private var statusObservation: NSKeyValueObservation?
    private var stopped = false

    init(mediaURL: URL, failure: @escaping () -> Void) {
        let item = AVPlayerItem(url: mediaURL)
        let queuePlayer = AVQueuePlayer()
        let playerLayer = AVPlayerLayer(player: queuePlayer)
        self.queuePlayer = queuePlayer
        self.playerLayer = playerLayer
        super.init(frame: .zero)

        isUserInteractionEnabled = false
        backgroundColor = .clear
        playerLayer.videoGravity = .resizeAspectFill
        layer.addSublayer(playerLayer)
        queuePlayer.isMuted = true
        queuePlayer.actionAtItemEnd = .none
        looper = AVPlayerLooper(player: queuePlayer, templateItem: item)
        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard let self, !self.stopped else { return }
            switch item.status {
            case .readyToPlay:
                self.queuePlayer.play()
            case .failed:
                DispatchQueue.main.async { failure() }
            default:
                break
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer.frame = bounds
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        statusObservation?.invalidate()
        statusObservation = nil
        looper?.disableLooping()
        looper = nil
        queuePlayer.pause()
        queuePlayer.removeAllItems()
        playerLayer.player = nil
    }

    deinit {
        stop()
    }
}
