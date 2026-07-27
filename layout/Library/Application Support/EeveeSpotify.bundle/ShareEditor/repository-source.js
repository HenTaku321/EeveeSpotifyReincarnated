(function initLyricsRepositorySource(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsRepositorySource = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLyricsRepositorySource() {
  "use strict";

  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const LIST_ENDPOINT = "/v1/repository/list";
  const FILE_ENDPOINT = "/v1/repository/file";

  function normalizePath(value, allowDirectory = false) {
    let path = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    path = path.replace(/\/{2,}/g, "/");
    if (!path) return allowDirectory ? "lyrics" : "";
    const parts = path.split("/");
    if (parts[0] !== "lyrics" || parts.some((part) => !part || part === "." || part === "..")) return "";
    if (allowDirectory) return path;
    return /\.json$/i.test(path) ? path : "";
  }

  function normalizeEntry(value) {
    const type = value && value.type === "dir" ? "dir" : "file";
    const path = normalizePath(value && value.path, type === "dir");
    if (!path || (type === "dir" && path === "lyrics")) return null;
    return {
      type,
      path,
      name: String(value && value.name || path.split("/").pop() || "").trim(),
      size: Math.max(0, Number(value && value.size) || 0),
      sha: String(value && (value.sha || value.SHA) || ""),
    };
  }

  function filterEntries(entries, query = "") {
    const needle = String(query || "").trim().toLocaleLowerCase();
    return (Array.isArray(entries) ? entries : [])
      .map(normalizeEntry)
      .filter(Boolean)
      .filter((entry) => !needle || `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
  }

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function toEditorDocument(envelope, fallbackTrack = null) {
    if (!plainObject(envelope) || envelope.ok === false || !plainObject(envelope.content)) {
      throw new TypeError("仓库文件响应无效");
    }
    const content = envelope.content;
    const track = plainObject(content.track) ? content.track : plainObject(fallbackTrack) ? fallbackTrack : {};
    const lyrics = plainObject(content.lyrics) ? content.lyrics : null;
    if (!lyrics || !Array.isArray(plainObject(lyrics.lyrics) ? lyrics.lyrics.lines : lyrics.lines)) {
      throw new TypeError("仓库文件不包含可编辑歌词");
    }
    return {
      source: "github",
      hash: typeof content.hash === "string" ? content.hash : "",
      track: {
        trackId: String(track.trackId || track.id || ""),
        title: String(track.title || track.name || ""),
        artist: String(track.artist || track.artistName || ""),
        album: String(track.album || track.albumName || ""),
        coverUrl: String(track.coverUrl || track.artworkUrl || ""),
      },
      lyrics,
      colors: plainObject(content.colors) ? content.colors : undefined,
      repository: {
        path: normalizePath(envelope.path),
        sha: String(envelope.sha || ""),
      },
    };
  }

  async function decodeResponse(response) {
    const announced = Number(response && response.headers && response.headers.get && response.headers.get("Content-Length"));
    if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) throw new RangeError("仓库响应过大");
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new RangeError("仓库响应过大");
    let payload;
    try { payload = JSON.parse(body); } catch (_) { throw new Error("仓库返回了无效 JSON"); }
    if (!response.ok || !plainObject(payload) || payload.ok !== true) {
      throw new Error(String(payload && (payload.reason || payload.error) || `仓库请求失败 (${response.status})`));
    }
    return payload;
  }

  function createClient(fetchImpl, token = "") {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    const headers = { Accept: "application/json" };
    const normalizedToken = String(token || "").trim();
    if (normalizedToken) headers["X-MITM-Lyrics-Token"] = normalizedToken;
    return Object.freeze({
      async list(path = "lyrics") {
        const directory = normalizePath(path, true);
        if (!directory) throw new TypeError("仓库目录无效");
        const payload = await decodeResponse(await fetchImpl(`${LIST_ENDPOINT}?path=${encodeURIComponent(directory)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", headers,
        }));
        return { path: normalizePath(payload.path, true) || directory, entries: filterEntries(payload.entries) };
      },
      async read(path) {
        const filePath = normalizePath(path);
        if (!filePath) throw new TypeError("仓库文件路径无效");
        const payload = await decodeResponse(await fetchImpl(`${FILE_ENDPOINT}?path=${encodeURIComponent(filePath)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", headers,
        }));
        return toEditorDocument(payload);
      },
    });
  }

  function readBootstrap(search) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const track = {
      trackId: String(params.get("trackId") || "").trim(),
      title: String(params.get("title") || "").trim(),
      artist: String(params.get("artist") || "").trim(),
      album: String(params.get("album") || "").trim(),
    };
    return {
      track,
      source: String(params.get("source") || "browser").trim().slice(0, 32),
    };
  }

  return Object.freeze({
    FILE_ENDPOINT,
    LIST_ENDPOINT,
    MAX_RESPONSE_BYTES,
    createClient,
    filterEntries,
    normalizeEntry,
    normalizePath,
    readBootstrap,
    toEditorDocument,
  });
});
