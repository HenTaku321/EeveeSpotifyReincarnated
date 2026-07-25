(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsTimelineState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(String(value)).byteLength;
  }

  function asText(value) {
    return String(value == null ? "" : value);
  }

  function validMilliseconds(value) {
    const raw = asText(value).trim();
    if (!raw) return "";
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0 || number > 86_400_000) return "";
    return String(Math.round(number));
  }

  function splitTranslation(words) {
    const raw = asText(words);
    const match = /^(.*?)(?:\s*\(([^()]*)\))\s*$/.exec(raw);
    if (!match || !match[2].trim()) return { base: raw, translation: "", style: "paren" };
    return { base: match[1], translation: match[2].trim(), style: "paren" };
  }

  function normalizeSyllables(value) {
    const source = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return source.map((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return {
          index: Number.isFinite(Number(item.index)) ? Math.max(0, Number(item.index)) : index,
          timeMs: validMilliseconds(item.timeMs ?? item.ms ?? item.startTimeMs ?? item.start),
          text: asText(item.text ?? item.word ?? item.value).trim(),
        };
      }
      const raw = asText(item).trim();
      const match = /^(\d+)\s*[:|]\s*(.*)$/.exec(raw);
      return {
        index,
        timeMs: match ? validMilliseconds(match[1]) : "",
        text: (match ? match[2] : raw).trim(),
      };
    }).filter((item) => item.text || item.timeMs);
  }

  function cueTokens(value) {
    const text = asText(value).trim();
    if (!text) return [];
    try {
      if (typeof Intl === "object" && typeof Intl.Segmenter === "function") {
        const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(text))
          .filter((item) => item.isWordLike !== false)
          .map((item) => asText(item.segment).trim())
          .filter(Boolean);
        if (segments.length) return segments;
      }
    } catch (_) {}
    return text.match(/[\p{Script=Han}]|[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu) || [];
  }

  function normalizeLine(line) {
    const source = line && typeof line === "object" ? line : {};
    const words = asText(source.words);
    const parts = splitTranslation(words);
    return {
      startTimeMs: validMilliseconds(source.startTimeMs),
      endTimeMs: validMilliseconds(source.endTimeMs),
      words,
      base: parts.base,
      translation: parts.translation,
      syllables: normalizeSyllables(source.syllables),
    };
  }

  function normalizeTrack(track) {
    const source = track && typeof track === "object" ? track : {};
    return {
      trackId: asText(source.trackId).trim(),
      title: asText(source.title).trim(),
      artist: asText(source.artist).trim(),
      album: asText(source.album).trim(),
    };
  }

  function translationScore(alternative) {
    const language = asText(alternative && alternative.language).toLowerCase();
    const contentType = asText(alternative && alternative.contentType).toLowerCase();
    return (language === "zh-cn" || language === "zh-hans" || language === "zh_hans" ? 8 : language.startsWith("zh") ? 6 : 0)
      + (contentType === "translation" || contentType === "1" ? 2 : 0);
  }

  function rankedTranslationAlternatives(lyrics, index) {
    const alternatives = Array.isArray(lyrics && lyrics.alternatives) ? lyrics.alternatives : [];
    return alternatives
      .filter((alternative) => Array.isArray(alternative && alternative.lines) && alternative.lines[index] != null)
      .sort((left, right) => translationScore(right) - translationScore(left));
  }

  function bestTranslationAlternative(lyrics, index) {
    return rankedTranslationAlternatives(lyrics, index)[0] || null;
  }

  function ensureTranslationAlternative(lyrics, lineCount) {
    if (!Array.isArray(lyrics.alternatives)) lyrics.alternatives = [];
    let alternative = lyrics.alternatives
      .filter((item) => item && typeof item === "object" && Array.isArray(item.lines))
      .sort((left, right) => translationScore(right) - translationScore(left))[0];
    if (!alternative) {
      alternative = {
        language: "zh-CN",
        contentType: "translation",
        isRtlLanguage: false,
        lines: [],
      };
      lyrics.alternatives.push(alternative);
    }
    while (alternative.lines.length < lineCount) alternative.lines.push("");
    return alternative;
  }

  function alternativeTranslation(lyrics, index) {
    for (const candidate of rankedTranslationAlternatives(lyrics, index)) {
      const value = asText(candidate.lines[index]).trim();
      if (value) return value;
    }
    return "";
  }

  function normalizeDocument(payload) {
    if (!payload || payload.ok !== true || !payload.lyrics) throw new Error("歌词服务返回了无效文档");
    const track = normalizeTrack(payload.track);
    if (!track.trackId || !track.title || !track.artist || !track.album) throw new Error("曲目身份不完整");
    const response = clone(payload.lyrics);
    if (!response.lyrics || typeof response.lyrics !== "object") throw new Error("歌词正文缺失");
    const lines = Array.isArray(response.lyrics.lines) ? response.lyrics.lines : [];
    if (!lines.length) throw new Error("当前曲目没有可编辑歌词");
    response.lyrics.lines = lines.map((sourceLine, index) => {
      const line = normalizeLine(sourceLine);
      const alternative = alternativeTranslation(response.lyrics, index);
      if (alternative) {
        if (line.translation && line.translation === alternative) line.words = line.base;
      } else if (line.translation) {
        ensureTranslationAlternative(response.lyrics, lines.length).lines[index] = line.translation;
        line.words = line.base;
      }
      delete line.base;
      delete line.translation;
      return line;
    });
    const syncType = asText(response.lyrics.syncType).trim().toUpperCase();
    response.lyrics.syncType = ["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED", "AUTO"].includes(syncType)
      ? syncType
      : "UNSYNCED";
    return {
      version: VERSION,
      hash: asText(payload.hash).trim(),
      track,
      lyrics: response,
    };
  }

  function createState(payload) {
    const document = normalizeDocument(payload);
    return {
      version: VERSION,
      document,
      selectedIndex: 0,
      cueEnabled: false,
      cueWordMode: false,
      player: { positionMs: 0, durationMs: 0, isPlaying: false, trackId: document.track.trackId },
    };
  }

  function lines(state) {
    return state.document.lyrics.lyrics.lines;
  }

  function viewLine(state, index) {
    const line = lines(state)[index];
    if (!line) return normalizeLine(null);
    const normalized = normalizeLine(line);
    const alternative = alternativeTranslation(state.document.lyrics.lyrics, index);
    if (!alternative) return normalized;
    return {
      ...normalized,
      base: normalized.translation === alternative ? normalized.base : asText(line.words),
      translation: alternative,
    };
  }

  function applyLine(state, index, patch) {
    const current = lines(state)[index];
    if (!current) return false;
    const hasBase = Object.prototype.hasOwnProperty.call(patch || {}, "base");
    const hasTranslation = Object.prototype.hasOwnProperty.call(patch || {}, "translation");
    const words = hasBase ? asText(patch.base) : asText(patch.words ?? current.words);
    lines(state)[index] = {
      startTimeMs: validMilliseconds(patch.startTimeMs ?? current.startTimeMs),
      endTimeMs: validMilliseconds(patch.endTimeMs ?? current.endTimeMs),
      words,
      syllables: Object.prototype.hasOwnProperty.call(patch || {}, "syllables")
        ? normalizeSyllables(patch.syllables)
        : normalizeSyllables(current.syllables),
    };
    if (hasTranslation) {
      const translation = asText(patch.translation).trim();
      const alternative = bestTranslationAlternative(state.document.lyrics.lyrics, index)
        || (translation ? ensureTranslationAlternative(state.document.lyrics.lyrics, lines(state).length) : null);
      if (alternative) alternative.lines[index] = translation;
    }
    return true;
  }

  function addLine(state, index) {
    const at = Math.max(0, Math.min(lines(state).length, Number(index)));
    lines(state).splice(at, 0, { startTimeMs: "", endTimeMs: "", words: "", syllables: [] });
    const alternatives = state.document.lyrics.lyrics.alternatives;
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative) => {
        if (Array.isArray(alternative && alternative.lines)) alternative.lines.splice(at, 0, "");
      });
    }
    state.selectedIndex = at;
    return at;
  }

  function removeLine(state, index) {
    if (lines(state).length <= 1) return false;
    const at = Math.max(0, Math.min(lines(state).length - 1, Number(index)));
    lines(state).splice(at, 1);
    const alternatives = state.document.lyrics.lyrics.alternatives;
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative) => {
        if (Array.isArray(alternative && alternative.lines)) alternative.lines.splice(at, 1);
      });
    }
    state.selectedIndex = Math.min(at, lines(state).length - 1);
    return true;
  }

  function setSyncType(state, syncType) {
    const value = asText(syncType).trim().toUpperCase();
    state.document.lyrics.lyrics.syncType = ["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED", "AUTO"].includes(value)
      ? value
      : "UNSYNCED";
  }

  function toSavePayload(state) {
    const response = clone(state.document.lyrics);
    response.lyrics.lines = lines(state).map((line) => ({
      startTimeMs: validMilliseconds(line.startTimeMs),
      words: asText(line.words),
      syllables: normalizeSyllables(line.syllables)
        .filter((item) => item.timeMs && item.text)
        .map((item) => `${item.timeMs}:${item.text}`),
      endTimeMs: validMilliseconds(line.endTimeMs),
    }));
    response.lyrics.previewLines = response.lyrics.lines.slice(0, 4).map((line) => clone(line));
    const selectedSync = asText(response.lyrics.syncType).trim().toUpperCase();
    response.lyrics.syncType = ["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED"].includes(selectedSync)
      ? selectedSync
      : (response.lyrics.lines.some((line) => line.startTimeMs) ? "LINE_SYNCED" : "UNSYNCED");
    return { hash: state.document.hash, lyrics: response, track: clone(state.document.track) };
  }

  function validateForSave(state) {
    if (!state || !state.document || !lines(state).length) return "歌词至少需要一行";
    if (!/^[0-9a-f]{64}$/i.test(asText(state.document.hash).trim())) return "原始歌词 hash 无效";
    const selectedSyncType = asText(state.document.lyrics.lyrics.syncType).trim().toUpperCase();
    const syncType = ["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED"].includes(selectedSyncType)
      ? selectedSyncType
      : (lines(state).some((line) => validMilliseconds(line.startTimeMs)) ? "LINE_SYNCED" : "UNSYNCED");
    for (let index = 0; index < lines(state).length; index += 1) {
      const line = lines(state)[index];
      if (!asText(line.words).trim()) return `第 ${index + 1} 行内容为空`;
      const start = validMilliseconds(line.startTimeMs);
      const end = validMilliseconds(line.endTimeMs);
      if (syncType !== "UNSYNCED" && !start) return `第 ${index + 1} 行缺少有效 start`;
      if (start && end && Number(end) < Number(start)) return `第 ${index + 1} 行 end 早于 start`;
      if (syncType === "SYLLABLE_SYNCED") {
        const syllables = normalizeSyllables(line.syllables);
        if (!syllables.length || syllables.some((item) => !item.timeMs || !item.text)) return `第 ${index + 1} 行逐词时间不完整`;
      }
    }
    return "";
  }

  function serializeState(state) {
    const snapshot = {
      version: VERSION,
      document: state.document,
      selectedIndex: state.selectedIndex,
      cueEnabled: Boolean(state.cueEnabled),
      cueWordMode: Boolean(state.cueWordMode),
    };
    const serialized = JSON.stringify(snapshot);
    if (utf8ByteLength(serialized) > MAX_DOCUMENT_BYTES) throw new RangeError("歌词草稿超过大小限制");
    return serialized;
  }

  function restoreState(state, serialized) {
    const snapshot = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
    if (!snapshot || snapshot.version !== VERSION || !snapshot.document) throw new Error("歌词草稿版本不兼容");
    if (snapshot.document.track.trackId !== state.document.track.trackId) throw new Error("歌词草稿曲目不匹配");
    const restored = normalizeDocument({
      ok: true,
      hash: snapshot.document.hash,
      track: snapshot.document.track,
      lyrics: snapshot.document.lyrics,
    });
    state.document = restored;
    state.selectedIndex = Math.max(0, Math.min(lines(state).length - 1, Number(snapshot.selectedIndex) || 0));
    state.cueEnabled = snapshot.cueEnabled === true;
    state.cueWordMode = snapshot.cueWordMode === true;
    return state;
  }

  return Object.freeze({
    VERSION,
    MAX_DOCUMENT_BYTES,
    clone,
    utf8ByteLength,
    cueTokens,
    normalizeSyllables,
    normalizeLine,
    normalizeDocument,
    createState,
    lines,
    viewLine,
    applyLine,
    addLine,
    removeLine,
    setSyncType,
    toSavePayload,
    validateForSave,
    serializeState,
    restoreState,
    splitTranslation,
    alternativeTranslation,
  });
});
