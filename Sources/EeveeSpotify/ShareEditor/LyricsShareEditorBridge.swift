import Foundation
import UIKit
import WebKit

protocol LyricsShareEditorBridgeDelegate: AnyObject {
    func lyricsShareEditorBridge(_ bridge: LyricsShareEditorBridge, didReceive message: WKScriptMessage)
}

final class LyricsShareEditorBridge: NSObject, WKScriptMessageHandler {
    weak var delegate: LyricsShareEditorBridgeDelegate?

    init(delegate: LyricsShareEditorBridgeDelegate?) {
        self.delegate = delegate
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.lyricsShareEditorBridge(self, didReceive: message)
    }
}

struct LyricsShareEditorPNG {
    static let maximumBytes = 8 * 1024 * 1024
    static let maximumDimension = 4096
    static let maximumPixels = 16_777_216

    let data: Data
    let filename: String

    static func decode(base64: String, suggestedFilename: String) throws -> LyricsShareEditorPNG {
        let maximumBase64Characters = ((maximumBytes + 2) / 3) * 4
        guard !base64.isEmpty, base64.utf8.count <= maximumBase64Characters else {
            throw LyricsShareEditorError.export("PNG 数据大小超过 8 MiB 限制。")
        }
        guard let data = Data(base64Encoded: base64), data.count <= maximumBytes else {
            throw LyricsShareEditorError.export("PNG 数据不是有效的 Base64，或大小超过限制。")
        }

        let signature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        guard data.count >= 24,
              data.prefix(signature.count) == signature,
              Array(data[8..<12]) == [0, 0, 0, 13],
              Array(data[12..<16]) == Array("IHDR".utf8) else {
            throw LyricsShareEditorError.export("导出内容不是有效 PNG。")
        }

        let width = Int(readUInt32(data, at: 16))
        let height = Int(readUInt32(data, at: 20))
        guard width > 0, height > 0,
              width <= maximumDimension, height <= maximumDimension,
              width <= maximumPixels / height else {
            throw LyricsShareEditorError.export("PNG 像素尺寸超过限制。")
        }

        let imageIsValid = autoreleasepool { UIImage(data: data) != nil }
        guard imageIsValid else {
            throw LyricsShareEditorError.export("PNG 图像无法解码。")
        }

        return LyricsShareEditorPNG(data: data, filename: sanitizedFilename(suggestedFilename))
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        data[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }

    private static func sanitizedFilename(_ input: String) -> String {
        let illegal = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let pieces = input.precomposedStringWithCompatibilityMapping.components(separatedBy: illegal)
        var value = pieces.joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasSuffix(".png") {
            value.removeLast(4)
        }
        if value.isEmpty { value = "lyrics-card" }
        value = String(value.prefix(80))
        return value + ".png"
    }
}
