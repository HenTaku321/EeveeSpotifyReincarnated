(function initLyricsTimelineBrowserHost(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsTimelineBrowserHost = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLyricsTimelineBrowserHost() {
  "use strict";

  const LOAD_ENDPOINT = "/v1/share-editor/lyrics";
  const SAVE_ENDPOINT = "/v1/lyrics/edit";
  const VALIDATE_CANONICAL_ENDPOINT = "/v1/share-editor/validate";
  const TRANSLATE_ENDPOINT = "/v1/share-editor/translate";
  const MODELS_ENDPOINT = "/v1/translation/models";
  const SEGMENTS_ENDPOINT = "/v1/segments";
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  async function readJSON(response) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new RangeError("歌词响应过大");
    let payload;
    try { payload = JSON.parse(body); } catch (_) { throw new Error("歌词服务返回了无效 JSON"); }
    if (!response.ok || !payload || payload.ok !== true) {
      const reason = String(payload && (payload.reason || payload.error) || `歌词请求失败 (${response.status})`);
      const missing = Array.isArray(payload?.missingFields) ? payload.missingFields.map(String).filter(Boolean) : [];
      const details = [];
      if (payload?.detail) details.push(String(payload.detail));
      if (missing.length) details.push(`missing fields: ${missing.join(", ")}`);
      if (Number(payload?.upstreamStatus) > 0) details.push(`upstream HTTP ${Number(payload.upstreamStatus)}`);
      const detail = details.join("; ");
      const error = new Error(detail ? `${reason}: ${detail}` : reason);
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
        if (command === "translate") {
          return request(TRANSLATE_ENDPOINT, { method: "POST", body: JSON.stringify(message.payload || {}) });
        }
        if (command === "models") {
          return request(MODELS_ENDPOINT, { method: "GET" });
        }
        if (command === "validateCanonical") {
          return request(VALIDATE_CANONICAL_ENDPOINT, { method: "POST", body: JSON.stringify(message.payload || {}) });
        }
        if (command === "segmentsGet") {
          const trackId = String(message.trackId || "").trim();
          if (!trackId) throw new TypeError("片段规则请求缺少 track ID");
          return request(`${SEGMENTS_ENDPOINT}?trackId=${encodeURIComponent(trackId)}`, { method: "GET" });
        }
        if (command === "segmentsPut") {
          return request(SEGMENTS_ENDPOINT, { method: "PUT", body: JSON.stringify(message.payload || {}) });
        }
        if (command !== "save") return null;
        try {
          const result = await request(SAVE_ENDPOINT, { method: "POST", body: JSON.stringify(message.payload || {}) });
          if (message.notify !== false) options.onSaveResult({ ok: true, hash: String(result.hash || "") });
          return result;
        } catch (error) {
          if (message.notify !== false) {
            options.onSaveResult({
              ok: false,
              reason: String(error.payload?.reason || error.message || "save-failed"),
              currentHash: String(error.payload?.hash || error.payload?.currentHash || ""),
            });
          }
          throw error;
        }
      },
    });
  }

  return Object.freeze({ LOAD_ENDPOINT, SAVE_ENDPOINT, VALIDATE_CANONICAL_ENDPOINT, TRANSLATE_ENDPOINT, MODELS_ENDPOINT, SEGMENTS_ENDPOINT, createHost });
});
