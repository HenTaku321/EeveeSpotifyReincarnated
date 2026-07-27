(function initLyricsTimelineBrowserHost(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsTimelineBrowserHost = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLyricsTimelineBrowserHost() {
  "use strict";

  const LOAD_ENDPOINT = "/v1/share-editor/lyrics";
  const SAVE_ENDPOINT = "/v1/lyrics/edit";
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  async function readJSON(response) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new RangeError("歌词响应过大");
    let payload;
    try { payload = JSON.parse(body); } catch (_) { throw new Error("歌词服务返回了无效 JSON"); }
    if (!response.ok || !payload || payload.ok !== true) {
      const error = new Error(String(payload && (payload.reason || payload.error) || `歌词请求失败 (${response.status})`));
      error.status = Number(response.status || 0);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function createHost(options) {
    if (typeof options?.fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof options?.applyDocument !== "function") throw new TypeError("applyDocument is required");
    let token = "";
    const request = async (url, init) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (token) headers["X-MITM-Lyrics-Token"] = token;
      return readJSON(await options.fetchImpl(url, { ...init, headers, credentials: "same-origin", cache: "no-store" }));
    };
    return Object.freeze({
      async bootstrap(payload) {
        const track = payload && payload.track;
        if (!track || !String(track.trackId || "").trim()) throw new TypeError("当前曲目缺少 track ID");
        token = String(payload.token || "").trim();
        const document = await request(LOAD_ENDPOINT, {
          method: "POST",
          body: JSON.stringify({ track: {
            trackId: String(track.trackId || "").trim(),
            title: String(track.title || "").trim(),
            artist: String(track.artist || "").trim(),
            album: String(track.album || "").trim(),
          } }),
        });
        options.applyDocument(document);
        return document;
      },
      async command(message) {
        const command = String(message && message.command || "");
        if (["getPlayerState", "seek", "play", "pause"].includes(command)) {
          options.postPlayerCommand?.({
            command,
            ...(command === "seek" ? { positionMs: Math.max(0, Math.round(Number(message.positionMs) || 0)) } : {}),
          });
          return null;
        }
        if (command !== "save") return null;
        try {
          const result = await request(SAVE_ENDPOINT, { method: "POST", body: JSON.stringify(message.payload || {}) });
          options.onSaveResult({ ok: true, hash: String(result.hash || "") });
          return result;
        } catch (error) {
          options.onSaveResult({
            ok: false,
            reason: String(error.payload?.reason || error.message || "save-failed"),
            currentHash: String(error.payload?.currentHash || ""),
          });
          throw error;
        }
      },
    });
  }

  return Object.freeze({ LOAD_ENDPOINT, SAVE_ENDPOINT, createHost });
});
