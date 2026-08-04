(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsTimelineState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 2;
  const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
  const LRC_METADATA_KEYS = new Set(["id", "ar", "al", "ti", "au", "by", "re", "ve", "length"]);
  const LRC_METADATA_NAMES = Object.freeze({ ar: "artist", al: "album", ti: "title" });

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

  function parseLRC(value) {
    const source = asText(value).replace(/^\uFEFF/, "");
    const records = [];
    const errors = [];
    const metadata = {};
    let offsetMs = 0;
    let order = 0;

    source.split(/\r\n|\n|\r/).forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const line = rawLine.replace(/^[\t ]+/, "");
      if (!line.trim()) return;

      const tagMatch = /^\[([a-z]+):(.*)\][\t ]*$/i.exec(line);
      if (tagMatch) {
        const key = tagMatch[1].toLowerCase();
        const tagValue = tagMatch[2].trim();
        if (key === "offset") {
          if (!/^[+-]?\d+$/.test(tagValue)) errors.push({ lineNumber, reason: "offset 必须是整数毫秒" });
          else offsetMs = Number(tagValue);
          return;
        }
        if (LRC_METADATA_KEYS.has(key)) {
          if (LRC_METADATA_NAMES[key]) metadata[LRC_METADATA_NAMES[key]] = tagValue;
          return;
        }
      }

      const timestamps = [];
      let remainder = line;
      while (true) {
        const match = /^\[(\d{2,}):([0-5]\d)(?:\.(\d{2}|\d{3}))?\]/.exec(remainder);
        if (!match) break;
        const fractionMs = !match[3] ? 0 : Number(match[3]) * (match[3].length === 2 ? 10 : 1);
        timestamps.push((Number(match[1]) * 60 + Number(match[2])) * 1000 + fractionMs);
        remainder = remainder.slice(match[0].length);
      }

      if (!timestamps.length) {
        errors.push({
          lineNumber,
          reason: line.startsWith("[") ? "无法识别的标签或时间戳" : "非空歌词行缺少有效时间戳",
        });
        return;
      }

      const words = remainder.trim() ? remainder : "";
      timestamps.forEach((startMs) => {
        records.push({ startMs, words, order });
        order += 1;
      });
    });

    const lines = records.map((record) => ({
      ...record,
      startMs: Math.max(0, record.startMs + offsetMs),
    })).sort((left, right) => left.startMs - right.startMs || left.order - right.order).map((record) => ({
      startTimeMs: String(record.startMs),
      words: record.words,
      syllables: [],
      endTimeMs: "0",
    }));

    if (!lines.length) errors.push({ lineNumber: 0, reason: "至少需要一行带有效时间戳的歌词" });
    return { lines, metadata, errors };
  }

  function findMatchingOpenIndex(text, openChar, closeChar) {
    let depth = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (text[index] === closeChar) depth += 1;
      else if (text[index] === openChar) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  function splitTranslation(words) {
    const raw = asText(words).replace(/\s+$/, "");
    const pair = raw.endsWith(")")
      ? { open: "(", close: ")" }
      : raw.endsWith("）")
        ? { open: "（", close: "）" }
        : null;
    if (!pair) return { base: raw, translation: "", style: "paren" };
    const openIndex = findMatchingOpenIndex(raw, pair.open, pair.close);
    if (openIndex <= 0) return { base: raw, translation: "", style: "paren" };
    const base = raw.slice(0, openIndex).replace(/\s+$/, "");
    const translation = raw.slice(openIndex + 1, -1).trim();
    if (!base || !translation) return { base: raw, translation: "", style: "paren" };
    return { base, translation, style: "paren" };
  }

  function buildWords(base, translation, oldWords) {
    const left = asText(base);
    const right = asText(translation).trim();
    if (!right) {
      const oldParts = splitTranslation(oldWords);
      return left || (oldParts.translation ? oldParts.base : asText(oldWords));
    }
    const delimiter = asciiParenthesesBalanced(left) ? ["(", ")"] : ["（", "）"];
    return `${left}${delimiter[0]}${right}${delimiter[1]}`;
  }

  function asciiParenthesesBalanced(value) {
    let depth = 0;
    for (const character of asText(value)) {
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
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

  function normalizeShortcutKey(event) {
    const code = asText(event?.code).toLowerCase();
    if (code === "keyw") return "w";
    if (code === "keye") return "e";
    if (code === "keyq") return "q";
    if (code === "arrowup") return "arrowup";
    if (code === "arrowdown") return "arrowdown";
    const key = asText(event?.key).toLowerCase();
    return key === "process" || key === "unidentified" ? "" : key;
  }

  function resolveCueShortcut(event, state) {
    if (!state || event?.ctrlKey || event?.metaKey || event?.altKey || event?.isComposing) return "";
    const key = normalizeShortcutKey(event);
    if (key === "arrowup") return "previous-line";
    if (key === "arrowdown") return "next-line";
    if (key === "q") return "preview-current";
    if (state.cueEnabled !== true) return "";
    if (key === "w" && event?.shiftKey) return "previous-line";
    if (key === "w") return "cue-primary";
    if (key === "e") return "cue-end";
    return "";
  }

  function normalizeLine(line, inferTimedEmpty) {
    const source = line && typeof line === "object" ? line : {};
    const words = asText(source.words);
    const parts = splitTranslation(words);
    const startTimeMs = validMilliseconds(source.startTimeMs);
    const hasEmptyMarker = Object.prototype.hasOwnProperty.call(source, "allowEmptyWords");
    return {
      startTimeMs,
      endTimeMs: validMilliseconds(source.endTimeMs),
      words,
      base: parts.base,
      translation: parts.translation,
      syllables: normalizeSyllables(source.syllables),
      allowEmptyWords: !words.trim() && (source.allowEmptyWords === true || (!hasEmptyMarker && inferTimedEmpty === true && Boolean(startTimeMs))),
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

  function normalizeDocument(payload) {
    if (!payload || payload.ok !== true || !payload.lyrics) throw new Error("歌词服务返回了无效文档");
    const track = normalizeTrack(payload.track);
    if (!track.trackId || !track.title || !track.artist || !track.album) throw new Error("曲目身份不完整");
    const response = clone(payload.lyrics);
    if (!response.lyrics || typeof response.lyrics !== "object") throw new Error("歌词正文缺失");
    const lines = Array.isArray(response.lyrics.lines) ? response.lyrics.lines : [];
    if (!lines.length) throw new Error("当前曲目没有可编辑歌词");
    response.lyrics.lines = lines.map((sourceLine) => {
      const line = normalizeLine(sourceLine, true);
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

  function moveSelection(state, delta) {
    const lastIndex = Math.max(0, lines(state).length - 1);
    const current = Number.isFinite(Number(state.selectedIndex)) ? Number(state.selectedIndex) : 0;
    state.selectedIndex = Math.max(0, Math.min(lastIndex, current + Number(delta || 0)));
    return state.selectedIndex;
  }

  function viewLine(state, index) {
    const line = lines(state)[index];
    if (!line) return normalizeLine(null);
    return normalizeLine(line);
  }

  function applyLine(state, index, patch) {
    const current = lines(state)[index];
    if (!current) return false;
    const next = viewLine(state, index);
    if (Object.prototype.hasOwnProperty.call(patch || {}, "base")) next.base = asText(patch.base);
    if (Object.prototype.hasOwnProperty.call(patch || {}, "translation")) next.translation = asText(patch.translation);
    const words = Object.prototype.hasOwnProperty.call(patch || {}, "base")
      || Object.prototype.hasOwnProperty.call(patch || {}, "translation")
      ? buildWords(next.base, next.translation, current.words)
      : asText(patch.words ?? current.words);
    const changesWords = ["base", "translation", "words"].some((key) => Object.prototype.hasOwnProperty.call(patch || {}, key));
    lines(state)[index] = {
      startTimeMs: validMilliseconds(patch.startTimeMs ?? next.startTimeMs),
      endTimeMs: validMilliseconds(patch.endTimeMs ?? next.endTimeMs),
      words,
      syllables: Object.prototype.hasOwnProperty.call(patch || {}, "syllables")
        ? normalizeSyllables(patch.syllables)
        : normalizeSyllables(current.syllables),
      allowEmptyWords: current.allowEmptyWords === true && !changesWords,
    };
    return true;
  }

  function addLine(state, index) {
    const at = Math.max(0, Math.min(lines(state).length, Number(index)));
    lines(state).splice(at, 0, { startTimeMs: "", endTimeMs: "", words: "", syllables: [], allowEmptyWords: false });
    state.selectedIndex = at;
    return at;
  }

  function removeLine(state, index) {
    if (lines(state).length <= 1) return false;
    const at = Math.max(0, Math.min(lines(state).length - 1, Number(index)));
    lines(state).splice(at, 1);
    state.selectedIndex = Math.min(at, lines(state).length - 1);
    return true;
  }

  function setSyncType(state, syncType) {
    const value = asText(syncType).trim().toUpperCase();
    state.document.lyrics.lyrics.syncType = ["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED", "AUTO"].includes(value)
      ? value
      : "UNSYNCED";
  }

  function normalizeImportedLines(importedLines, includeEmptyMarker) {
    if (!Array.isArray(importedLines) || !importedLines.length) {
      throw new Error("导入歌词至少需要一行");
    }
    return importedLines.map((sourceLine, index) => {
      const line = normalizeLine(sourceLine);
      if (!line.startTimeMs) throw new Error(`第 ${index + 1} 行缺少有效 start`);
      const normalized = {
        startTimeMs: line.startTimeMs,
        endTimeMs: line.endTimeMs || "0",
        words: line.words.trim() ? line.words : "",
        syllables: [],
      };
      if (includeEmptyMarker) normalized.allowEmptyWords = !line.words.trim();
      return normalized;
    });
  }

  function replaceLinesFromLRC(state, importedLines) {
    if (!state || !state.document) throw new Error("当前歌词文档无效");
    const replacement = normalizeImportedLines(importedLines, true);
    state.document.lyrics.lyrics.lines = replacement;
    state.document.lyrics.lyrics.syncType = "LINE_SYNCED";
    state.selectedIndex = 0;
    return true;
  }

  function createTranslationCandidate(state, importedLines) {
    if (!state || !state.document || !state.document.lyrics?.lyrics) throw new Error("当前歌词文档无效");
    const response = clone(state.document.lyrics);
    const replacement = normalizeImportedLines(importedLines, false);
    delete response.static;
    delete response.noLyrics;
    delete response.reason;
    response.lyrics.syncType = "LINE_SYNCED";
    response.lyrics.lines = replacement;
    response.lyrics.previewLines = replacement.slice(0, 4).map((line) => clone(line));
    return { track: clone(state.document.track), lyrics: response };
  }

  function validateTranslationResponse(payload) {
    if (!payload || payload.ok !== true || !payload.lyrics || typeof payload.lyrics !== "object") {
      throw new Error("翻译服务返回了无效歌词");
    }
    const response = clone(payload.lyrics);
    if (!response.lyrics || typeof response.lyrics !== "object" || !Array.isArray(response.lyrics.lines) || !response.lyrics.lines.length) {
      throw new Error("翻译响应缺少完整歌词");
    }
    if (!response.colors || typeof response.colors !== "object"
      || !["background", "text", "highlightText"].every((key) => typeof response.colors[key] === "number" && Number.isFinite(response.colors[key]))) {
      throw new Error("翻译响应缺少歌词颜色");
    }
    const syncType = asText(response.lyrics.syncType).trim().toUpperCase();
    if (!["UNSYNCED", "LINE_SYNCED", "SYLLABLE_SYNCED"].includes(syncType)) {
      throw new Error("翻译响应同步类型无效");
    }
    response.lyrics.lines = response.lyrics.lines.map((sourceLine, index) => {
      if (!sourceLine || typeof sourceLine !== "object" || typeof sourceLine.words !== "string") {
        throw new Error(`翻译响应第 ${index + 1} 行无效`);
      }
      const line = normalizeLine(sourceLine, true);
      if (syncType !== "UNSYNCED" && !line.startTimeMs) {
        throw new Error(`翻译响应第 ${index + 1} 行缺少有效 start`);
      }
      return {
        startTimeMs: line.startTimeMs,
        endTimeMs: line.endTimeMs,
        words: line.words,
        syllables: normalizeSyllables(sourceLine.syllables),
        allowEmptyWords: !line.words.trim() && Boolean(line.startTimeMs),
      };
    });
    delete response.static;
    delete response.noLyrics;
    delete response.reason;
    response.lyrics.syncType = syncType;
    response.lyrics.previewLines = response.lyrics.lines.slice(0, 4).map((line) => {
      const preview = clone(line);
      delete preview.allowEmptyWords;
      return preview;
    });
    return { lyrics: response };
  }

  function replaceLyricsFromTranslation(state, validated) {
    if (!state || !state.document || !validated?.lyrics?.lyrics?.lines?.length) {
      throw new Error("翻译响应缺少完整歌词");
    }
    state.document.lyrics = clone(validated.lyrics);
    state.selectedIndex = 0;
    return true;
  }

  function createRetranslationRequest(state, model) {
    if (!state || !state.document || !state.document.lyrics?.lyrics?.lines?.length) {
      throw new Error("当前歌词文档无效");
    }
    const selectedModel = asText(model).trim();
    if (!selectedModel) throw new Error("请选择翻译模型");
    const lyrics = toSavePayload(state).lyrics;
    lyrics.lyrics.lines = lyrics.lyrics.lines.map((line) => {
      const source = clone(line);
      const parts = splitTranslation(source.words);
      if (parts.translation) source.words = parts.base;
      return source;
    });
    lyrics.lyrics.previewLines = lyrics.lyrics.lines.slice(0, 4).map((line) => clone(line));
    return {
      track: clone(state.document.track),
      lyrics,
      model: selectedModel,
    };
  }

  function validateRetranslationResponse(state, payload) {
    const validated = validateTranslationResponse(payload);
    const currentLines = lines(state);
    const candidateLines = validated.lyrics.lyrics.lines;
    if (candidateLines.length !== currentLines.length) {
      throw new Error(`重译候选行数不一致：当前 ${currentLines.length} 行，候选 ${candidateLines.length} 行`);
    }
    const currentSyncType = asText(state.document.lyrics.lyrics.syncType).trim().toUpperCase();
    if (validated.lyrics.lyrics.syncType !== currentSyncType) {
      throw new Error(`重译候选同步类型不一致：当前 ${currentSyncType}，候选 ${validated.lyrics.lyrics.syncType}`);
    }
    candidateLines.forEach((candidateLine, index) => {
      const currentLine = currentLines[index];
      if (candidateLine.startTimeMs !== currentLine.startTimeMs || candidateLine.endTimeMs !== currentLine.endTimeMs
        || JSON.stringify(normalizeSyllables(candidateLine.syllables)) !== JSON.stringify(normalizeSyllables(currentLine.syllables))) {
        throw new Error(`重译候选第 ${index + 1} 行修改了时间信息`);
      }
      const candidateParts = splitTranslation(candidateLine.words);
      if (candidateParts.translation && candidateParts.base === asText(currentLine.words).replace(/\s+$/, "")) {
        const currentParts = splitTranslation(currentLine.words);
        candidateLine.words = buildWords(currentParts.base, candidateParts.translation, candidateLine.words);
      }
    });
    validated.lyrics.lyrics.previewLines = candidateLines.slice(0, 4).map((line) => {
      const preview = clone(line);
      delete preview.allowEmptyWords;
      return preview;
    });
    const model = asText(payload?.model).trim();
    const provider = asText(payload?.provider).trim();
    if (!model || !provider) throw new Error("重译响应缺少模型来源");
    return {
      lyrics: validated.lyrics,
      model,
      provider,
      static: payload?.static === true,
      geniusAnnotations: payload?.geniusAnnotations === true,
    };
  }

  function retranslationComparison(state, candidate) {
    if (!state || !candidate?.lyrics?.lyrics?.lines) throw new Error("重译候选无效");
    return lines(state).map((line, index) => {
      const candidateLine = candidate.lyrics.lyrics.lines[index];
      if (!candidateLine) throw new Error(`重译候选缺少第 ${index + 1} 行`);
      const current = splitTranslation(line.words);
      const next = splitTranslation(candidateLine.words);
      return {
        index,
        changed: current.base !== next.base || current.translation !== next.translation,
        current: { base: current.base, translation: current.translation },
        candidate: { base: next.base, translation: next.translation },
      };
    });
  }

  function createRetranslationSavePayload(state, candidate, makeStatic) {
    if (!state || !candidate?.lyrics?.lyrics?.lines?.length) throw new Error("重译候选无效");
    const response = clone(candidate.lyrics);
    response.static = makeStatic === true;
    delete response.noLyrics;
    delete response.reason;
    response.lyrics.lines = response.lyrics.lines.map((line) => {
      const serialized = clone(line);
      delete serialized.allowEmptyWords;
      return serialized;
    });
    response.lyrics.previewLines = response.lyrics.lines.slice(0, 4).map((line) => clone(line));
    return {
      hash: state.document.hash,
      lyrics: response,
      track: clone(state.document.track),
    };
  }

  function commitSavedRetranslation(state, candidate, makeStatic, hash) {
    const nextHash = asText(hash).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(nextHash)) throw new Error("保存响应 hash 无效");
    replaceLyricsFromTranslation(state, candidate);
    state.document.lyrics.static = makeStatic === true;
    state.document.hash = nextHash;
    return true;
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
      if (!asText(line.words).trim() && line.allowEmptyWords !== true) return `第 ${index + 1} 行内容为空`;
      const start = validMilliseconds(line.startTimeMs);
      const end = validMilliseconds(line.endTimeMs);
      if (syncType !== "UNSYNCED" && !start) return `第 ${index + 1} 行缺少有效 start`;
      if (start && end && Number(end) !== 0 && Number(end) < Number(start)) return `第 ${index + 1} 行 end 早于 start`;
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

  function normalizeSegmentDocument(payload, expectedTrackID) {
    const source = payload && payload.document && typeof payload.document === "object"
      ? payload.document
      : payload;
    if (!source || typeof source !== "object") throw new TypeError("片段规则响应缺少 document");
    const trackId = asText(source.trackId).trim();
    if (!trackId || trackId !== asText(expectedTrackID).trim()) throw new Error("片段规则响应的曲目不匹配");
    const version = Number(source.version);
    const revision = Number(source.revision);
    if (version !== 1 || !Number.isSafeInteger(revision) || revision < 0) throw new Error("片段规则版本或 revision 无效");
    if (!Array.isArray(source.rules)) throw new TypeError("片段规则列表无效");
    return { version: 1, trackId, revision, rules: clone(source.rules) };
  }

  function createSegmentSession(payload, expectedTrackID) {
    const document = normalizeSegmentDocument(payload, expectedTrackID);
    return { document, rules: clone(document.rules), conflict: null, dirty: false };
  }

  function segmentRuleIndex(session, id) {
    const index = session?.rules?.findIndex((rule) => asText(rule?.id) === asText(id)) ?? -1;
    if (index < 0) throw new Error("找不到要编辑的片段规则");
    return index;
  }

  function updateSegmentRule(session, id, patch) {
    const index = segmentRuleIndex(session, id);
    session.rules[index] = { ...session.rules[index], ...(patch && typeof patch === "object" ? patch : {}) };
    session.dirty = true;
    return session.rules[index];
  }

  function addSegmentRule(session, seed) {
    if (!session || !Array.isArray(session.rules)) throw new TypeError("片段规则会话无效");
    const used = new Set(session.rules.map((rule) => asText(rule?.id)));
    let sequence = 1;
    while (used.has(`segment-${sequence}`)) sequence += 1;
    const startMs = Math.max(0, Math.round(Number(seed?.startMs) || 0));
    const endMs = Math.max(startMs + 1, Math.round(Number(seed?.endMs) || startMs + 10_000));
    const rule = {
      id: `segment-${sequence}`,
      startMs,
      endMs,
      category: "custom",
      label: "",
      enabled: true,
    };
    session.rules.push(rule);
    session.dirty = true;
    return rule;
  }

  function removeSegmentRule(session, id) {
    const index = segmentRuleIndex(session, id);
    session.rules.splice(index, 1);
    session.dirty = true;
    return session;
  }

  function normalizedSegmentRule(rule, ids) {
    const id = asText(rule?.id).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error("片段 ID 只能包含字母、数字、点、下划线或连字符");
    if (ids.has(id)) throw new Error(`片段 ID 重复：${id}`);
    ids.add(id);
    const category = asText(rule?.category).trim().toLowerCase();
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(category)) throw new Error(`片段 ${id} 的分类无效`);
    const label = asText(rule?.label).trim();
    if (Array.from(label).length > 120) throw new Error(`片段 ${id} 的标签超过 120 个字符`);
    const startRaw = asText(rule?.startMs).trim();
    const endRaw = asText(rule?.endMs).trim();
    if (!/^\d+$/.test(startRaw)) throw new Error(`片段 ${id} 的开始时间无效`);
    if (!/^\d+$/.test(endRaw)) throw new Error(`片段 ${id} 的结束时间无效`);
    const startMs = Number(startRaw);
    const endMs = Number(endRaw);
    if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs > 86_400_000) throw new Error(`片段 ${id} 的开始时间无效`);
    if (!Number.isSafeInteger(endMs) || endMs > 86_400_000) throw new Error(`片段 ${id} 的结束时间无效`);
    if (endMs <= startMs) throw new Error(`片段 ${id} 的结束时间必须晚于开始时间`);
    return { id, startMs, endMs, category, label, enabled: rule?.enabled === true };
  }

  function toSegmentPutPayload(session) {
    if (!session?.document) throw new TypeError("片段规则会话无效");
    if (session.rules.length > 128) throw new Error("每首歌最多保存 128 个片段");
    const ids = new Set();
    const rules = session.rules.map((rule) => normalizedSegmentRule(rule, ids));
    rules.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
    return { trackId: session.document.trackId, revision: session.document.revision, rules };
  }

  function commitSegmentDocument(session, payload, expectedTrackID) {
    const document = normalizeSegmentDocument(payload, expectedTrackID);
    session.document = document;
    session.rules = clone(document.rules);
    session.conflict = null;
    session.dirty = false;
    return session;
  }

  function recordSegmentConflict(session, payload, expectedTrackID) {
    session.conflict = { document: normalizeSegmentDocument(payload, expectedTrackID) };
    return session;
  }

  function loadSegmentConflict(session) {
    if (!session?.conflict?.document) throw new Error("没有可载入的服务端冲突版本");
    const document = clone(session.conflict.document);
    session.document = document;
    session.rules = clone(document.rules);
    session.conflict = null;
    session.dirty = false;
    return session;
  }

  return Object.freeze({
    VERSION,
    MAX_DOCUMENT_BYTES,
    clone,
    utf8ByteLength,
    parseLRC,
    cueTokens,
    resolveCueShortcut,
    normalizeSyllables,
    normalizeLine,
    normalizeDocument,
    createState,
    lines,
    moveSelection,
    viewLine,
    applyLine,
    addLine,
    removeLine,
    setSyncType,
    replaceLinesFromLRC,
    createTranslationCandidate,
    validateTranslationResponse,
    replaceLyricsFromTranslation,
    createRetranslationRequest,
    validateRetranslationResponse,
    retranslationComparison,
    createRetranslationSavePayload,
    commitSavedRetranslation,
    toSavePayload,
    validateForSave,
    serializeState,
    restoreState,
    splitTranslation,
    buildWords,
    normalizeSegmentDocument,
    createSegmentSession,
    updateSegmentRule,
    addSegmentRule,
    removeSegmentRule,
    toSegmentPutPayload,
    commitSegmentDocument,
    recordSegmentConflict,
    loadSegmentConflict,
  });
});
