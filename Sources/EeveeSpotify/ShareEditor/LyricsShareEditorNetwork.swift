import Foundation

final class LyricsShareEditorSessionDelegate: NSObject, URLSessionDataDelegate {
    typealias Completion = (Data, URLResponse?, Error?) -> Void

    private let maximumBytes: Int
    private let oversizedResponseMessage: String
    private var completion: Completion?
    private var response: URLResponse?
    private var buffer = Data()
    private var boundaryError: Error?

    init(maximumBytes: Int,
         oversizedResponseMessage: String = "歌词服务响应超过 8 MiB 限制。",
         completion: @escaping Completion) {
        self.maximumBytes = maximumBytes
        self.oversizedResponseMessage = oversizedResponseMessage
        self.completion = completion
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response
        let expected = response.expectedContentLength
        if expected > Int64(maximumBytes) {
            boundaryError = LyricsShareEditorError.invalidResponse(oversizedResponseMessage)
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard boundaryError == nil else { return }
        guard data.count <= maximumBytes - buffer.count else {
            boundaryError = LyricsShareEditorError.invalidResponse(oversizedResponseMessage)
            dataTask.cancel()
            return
        }
        buffer.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let completion = self.completion
        self.completion = nil
        let data = buffer
        buffer.removeAll(keepingCapacity: false)
        completion?(data, response, boundaryError ?? error)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
