import Foundation
import WebKit

protocol LyricsTimelineEditorBridgeDelegate: AnyObject {
    func lyricsTimelineEditorBridge(_ bridge: LyricsTimelineEditorBridge, didReceive message: WKScriptMessage)
}

final class LyricsTimelineEditorBridge: NSObject, WKScriptMessageHandler {
    weak var delegate: LyricsTimelineEditorBridgeDelegate?

    init(delegate: LyricsTimelineEditorBridgeDelegate?) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.lyricsTimelineEditorBridge(self, didReceive: message)
    }
}
