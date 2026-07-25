(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShareEditorState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FONT_TYPES = Object.freeze(["classic", "wide", "narrow", "slanted"]);
  const TEXT_ALIGNMENTS = Object.freeze(["center", "leading", "trailing"]);
  const CAPS_MODES = Object.freeze(["normal", "allCaps"]);
  const MAX_SELECTED_LINES = 6;
  const HISTORY_LIMIT = 80;
  // Keep embedded resources bounded before they reach Canvas/Image decoding.
  // These limits are deliberately shared by file import, reducer actions, and
  // project restore so an untrusted project cannot bypass the picker checks.
  const MAX_STICKERS = 12;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
  const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
  const MAX_HISTORY_RESOURCE_BYTES = 32 * 1024 * 1024;
  const MAX_IMAGE_DIMENSION = 8192;
  const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
  const MAX_LYRICS_LINES = 5000;
  const MAX_ALTERNATIVES = 16;
  const MAX_LINE_TEXT_CHARS = 20000;
  const MAX_LYRICS_TEXT_BYTES = 4 * 1024 * 1024;

  function isPlainObject(value) {
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function asString(value, fallback) {
    return typeof value === "string" ? value.trim() : fallback;
  }

  function utf8ByteLength(value) {
    const text = String(value);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
    let bytes = 0;
    for (const character of text) {
      const code = character.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }

  function base64ByteLength(payload) {
    if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return -1;
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.max(0, (payload.length / 4) * 3 - padding);
  }

  function decodeBase64(payload) {
    if (typeof atob !== "function") throw new TypeError("base64 decoder is unavailable");
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0)
      + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8)
      + bytes[offset + 3];
  }

  function imageDimensionsFromBytes(bytes, mime) {
    if (!bytes || bytes.length < 12) throw new TypeError("image header is invalid");
    if (mime === "image/png") {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
        throw new TypeError("PNG header is invalid");
      }
      return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
    }
    if (mime === "image/jpeg") {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new TypeError("JPEG header is invalid");
      let offset = 2;
      while (offset + 3 < bytes.length) {
        while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) break;
        const marker = bytes[offset++];
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (offset + 1 >= bytes.length) break;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) break;
        const isFrame = (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf);
        if (isFrame && length >= 7) {
          return { width: (bytes[offset + 5] << 8) | bytes[offset + 6], height: (bytes[offset + 3] << 8) | bytes[offset + 4] };
        }
        offset += length;
      }
      throw new TypeError("JPEG dimensions are missing");
    }
    if (mime === "image/webp") {
      if (bytes.length < 16 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF"
        || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") {
        throw new TypeError("WebP header is invalid");
      }
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === "VP8X" && bytes.length >= 30) {
        return {
          width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
          height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        };
      }
      if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        return {
          width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
          height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
        };
      }
      if (chunk === "VP8 " && bytes.length >= 30
        && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return {
          width: (bytes[26] | ((bytes[27] & 0x3f) << 8)),
          height: (bytes[28] | ((bytes[29] & 0x3f) << 8)),
        };
      }
      throw new TypeError("WebP dimensions are missing");
    }
    throw new TypeError("unsupported image type");
  }

  function validateImageDimensions(dimensions) {
    const width = Number(dimensions && dimensions.width);
    const height = Number(dimensions && dimensions.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      throw new RangeError("图片像素尺寸超过限制");
    }
    return { width, height };
  }

  function parseImageDataURL(value) {
    if (typeof value !== "string") throw new TypeError("image data must be a string");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match) throw new TypeError("only base64 PNG, JPEG, or WebP data is allowed");
    const mime = match[1].toLowerCase();
    const payload = match[2];
    const byteLength = base64ByteLength(payload);
    if (byteLength < 1 || byteLength > MAX_IMAGE_BYTES) throw new RangeError("图片大小超过限制");
    const dimensions = validateImageDimensions(imageDimensionsFromBytes(decodeBase64(payload), mime));
    return { mime, byteLength, dimensions };
  }

  function validateImageDataURL(value) {
    parseImageDataURL(value);
    return value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function normalizeHexColor(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const unsigned = value >>> 0;
      const rgb = unsigned & 0xffffff;
      return `#${rgb.toString(16).padStart(6, "0")}`;
    }

    if (typeof value !== "string") return fallback;
    const color = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{8}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
    }
    return fallback;
  }

  function deepFreeze(value, seen) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    const visited = seen || new WeakSet();
    if (visited.has(value)) return value;
    visited.add(value);
    Object.freeze(value);
    Object.keys(value).forEach((key) => deepFreeze(value[key], visited));
    return value;
  }

  function normalizeLine(line, index) {
    if (!isPlainObject(line)) {
      throw new TypeError(`lyrics.lines[${index}] must be an object`);
    }
    const text = typeof line.words === "string"
      ? line.words
      : typeof line.text === "string"
        ? line.text
        : "";
    if (text.length > MAX_LINE_TEXT_CHARS) {
      throw new RangeError(`lyrics.lines[${index}] is too long`);
    }

    return {
      index,
      text,
      startTimeMs: asString(line.startTimeMs, ""),
      endTimeMs: asString(line.endTimeMs, ""),
    };
  }

  function normalizeAlternative(alternative, lineCount) {
    if (!isPlainObject(alternative) || !Array.isArray(alternative.lines)) return null;
    const lines = alternative.lines.slice(0, lineCount).map((line, index) => {
      if (typeof line === "string") return line;
      if (isPlainObject(line)) {
        if (typeof line.words === "string") return line.words;
        if (typeof line.text === "string") return line.text;
      }
      return "";
    });
    lines.forEach((line, index) => {
      if (line.length > MAX_LINE_TEXT_CHARS) throw new RangeError(`alternative.lines[${index}] is too long`);
    });
    while (lines.length < lineCount) lines.push("");
    return {
      language: asString(alternative.language, ""),
      isRtlLanguage: Boolean(alternative.isRtlLanguage),
      lines,
    };
  }

  function normalizeSelectedIndices(value, lines, useDefault) {
    const valid = [];
    const seen = new Set();
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const index = Number(item);
        if (!Number.isInteger(index) || index < 0 || index >= lines.length || seen.has(index)) return;
        seen.add(index);
        valid.push(index);
      });
    }

    if (!Array.isArray(value) && useDefault !== false) {
      for (const line of lines) {
        if (line.text.trim()) valid.push(line.index);
        if (valid.length >= 4) break;
      }
    }
    return valid.slice(0, MAX_SELECTED_LINES).sort((a, b) => a - b);
  }

  function normalizeDocument(input) {
    if (!isPlainObject(input)) throw new TypeError("document must be an object");
    if (input.source !== "github") throw new TypeError("document.source must be github");
    if (!isPlainObject(input.track)) throw new TypeError("document.track must be an object");

    const rawLyrics = isPlainObject(input.lyrics) && isPlainObject(input.lyrics.lyrics)
      ? input.lyrics.lyrics
      : input.lyrics;
    if (!isPlainObject(rawLyrics) || !Array.isArray(rawLyrics.lines)) {
      throw new TypeError("document.lyrics.lines must be an array");
    }

    if (rawLyrics.lines.length > MAX_LYRICS_LINES) throw new RangeError("document.lyrics.lines exceeds the limit");
    const lines = rawLyrics.lines.map(normalizeLine);
    if (lines.length === 0) throw new TypeError("document.lyrics.lines cannot be empty");

    const alternatives = Array.isArray(rawLyrics.alternatives)
      ? rawLyrics.alternatives.slice(0, MAX_ALTERNATIVES).map((item) => normalizeAlternative(item, lines.length)).filter(Boolean)
      : [];
    const lyricsTextBytes = lines.reduce((total, line) => total + utf8ByteLength(line.text), 0)
      + alternatives.reduce((total, alternative) => total
        + alternative.lines.reduce((lineTotal, line) => lineTotal + utf8ByteLength(line), 0), 0);
    if (lyricsTextBytes > MAX_LYRICS_TEXT_BYTES) throw new RangeError("document lyrics text exceeds the limit");
    const outerColors = isPlainObject(input.colors)
      ? input.colors
      : isPlainObject(input.lyrics) && isPlainObject(input.lyrics.colors)
        ? input.lyrics.colors
        : {};
    const rawCoverURL = asString(input.track.coverUrl, asString(input.track.artworkUrl, ""));
    let coverUrl = "";
    if (rawCoverURL) {
      try {
        coverUrl = validateImageDataURL(rawCoverURL);
      } catch (_error) {
        // Remote and path-based artwork is intentionally not auto-loaded. The
        // user can explicitly import a local cover into the project instead.
      }
    }
    const track = {
      trackId: asString(input.track.trackId, asString(input.track.id, "")),
      title: asString(input.track.title, asString(input.track.name, "Untitled")),
      artist: asString(input.track.artist, asString(input.track.artistName, "Unknown artist")),
      album: asString(input.track.album, asString(input.track.albumName, "")),
      coverUrl,
    };
    if (!track.trackId && track.title === "Untitled" && track.artist === "Unknown artist") {
      throw new TypeError("document.track must contain an identity field");
    }

    const document = {
      source: "github",
      hash: asString(input.hash, ""),
      track,
      lyrics: {
        syncType: asString(rawLyrics.syncType, "UNSYNCED"),
        provider: asString(rawLyrics.provider, "github"),
        providerLyricsId: asString(rawLyrics.providerLyricsId, ""),
        language: asString(rawLyrics.language, ""),
        isRtlLanguage: Boolean(rawLyrics.isRtlLanguage),
        lines,
        alternatives,
      },
      colors: {
        background: normalizeHexColor(outerColors.background, "#498cb7"),
        text: normalizeHexColor(outerColors.text, "#05090e"),
        highlightText: normalizeHexColor(outerColors.highlightText, "#ffffff"),
      },
      selectedLineIndices: normalizeSelectedIndices(input.selectedLineIndices, lines, true),
    };
    return deepFreeze(document);
  }

  function createEditorState(input) {
    const document = input && input.document && Object.isFrozen(input.document)
      ? input.document
      : normalizeDocument(input && input.document ? input.document : input);
    const overrides = input && input.document ? input : {};
    const initialStyle = isPlainObject(overrides.style) ? overrides.style : {};

    return {
      document,
      selectedLineIndices: normalizeSelectedIndices(
        Object.prototype.hasOwnProperty.call(overrides, "selectedLineIndices")
          ? overrides.selectedLineIndices
          : document.selectedLineIndices,
        document.lyrics.lines,
        false,
      ),
      edits: Object.create(null),
      style: {
        textColor: normalizeHexColor(initialStyle.textColor, document.colors.text),
        backgroundColor: normalizeHexColor(initialStyle.backgroundColor, document.colors.background),
        backgroundTintedColor: normalizeHexColor(initialStyle.backgroundTintedColor, "#000000").slice(0, 7),
        fontType: FONT_TYPES.includes(initialStyle.fontType) ? initialStyle.fontType : "classic",
        textAlignment: TEXT_ALIGNMENTS.includes(initialStyle.textAlignment)
          ? initialStyle.textAlignment
          : document.lyrics.isRtlLanguage ? "trailing" : "leading",
        capsMode: CAPS_MODES.includes(initialStyle.capsMode) ? initialStyle.capsMode : "normal",
      },
      media: {
        background: null,
        cover: null,
        useTrackArtworkAsBackground: false,
      },
      stickers: [],
      activeStickerId: null,
    };
  }

  function selectedLineText(state, index) {
    if (Object.prototype.hasOwnProperty.call(state.edits, index)) return state.edits[index];
    const line = state.document.lyrics.lines[index];
    return line ? line.text : "";
  }

  function getSelectedLines(state) {
    return state.selectedLineIndices.map((index) => ({
      index,
      text: selectedLineText(state, index),
    }));
  }

  function replaceSticker(stickers, id, updater) {
    let changed = false;
    const next = stickers.map((sticker) => {
      if (sticker.id !== id) return sticker;
      changed = true;
      return updater(sticker);
    });
    return changed ? next : stickers;
  }

  function normalizeMediaAsset(input) {
    if (!isPlainObject(input) || typeof input.src !== "string") {
      throw new TypeError("media.src is required");
    }
    const info = parseImageDataURL(input.src);
    const declaredType = asString(input.type, info.mime);
    if (declaredType !== info.mime) throw new TypeError("media type does not match its data URL");
    return {
      src: input.src,
      name: asString(input.name, "image").slice(0, 255),
      type: info.mime,
    };
  }

  function normalizeSticker(input, trustedImageData) {
    if (!isPlainObject(input) || typeof input.id !== "string" || !input.id || input.id.length > 200) {
      throw new TypeError("sticker.id is required");
    }
    if (typeof input.imageData !== "string" || !input.imageData) {
      throw new TypeError("sticker.imageData is required");
    }
    if (!trustedImageData) validateImageDataURL(input.imageData);
    return {
      id: input.id,
      stickerID: asString(input.stickerID, input.id).slice(0, 255),
      imageData: input.imageData,
      normalizedCenter: {
        x: clamp(input.normalizedCenter && input.normalizedCenter.x, 0, 1),
        y: clamp(input.normalizedCenter && input.normalizedCenter.y, 0, 1),
      },
      normalizedSize: {
        width: clamp(input.normalizedSize && input.normalizedSize.width, 0.06, 0.8),
        height: clamp(input.normalizedSize && input.normalizedSize.height, 0.06, 0.8),
      },
      rotation: Number.isFinite(Number(input.rotation)) ? Number(input.rotation) : 0,
    };
  }

  function stateImageSources(state) {
    const sources = [];
    const add = (source) => {
      if (typeof source === "string" && source.startsWith("data:image/")) sources.push(source);
    };
    add(state && state.document && state.document.track.coverUrl);
    add(state && state.media && state.media.background && state.media.background.src);
    add(state && state.media && state.media.cover && state.media.cover.src);
    if (state && Array.isArray(state.stickers)) state.stickers.forEach((sticker) => add(sticker.imageData));
    return sources;
  }

  function resourceStorageBytes(states) {
    const unique = new Set();
    let total = 0;
    states.forEach((state) => {
      stateImageSources(state).forEach((source) => {
        if (unique.has(source)) return;
        unique.add(source);
        total += utf8ByteLength(source);
      });
    });
    return total;
  }

  function assertStateResourceBudget(state) {
    if (state.stickers.length > MAX_STICKERS) throw new RangeError(`最多添加 ${MAX_STICKERS} 个贴纸`);
    if (resourceStorageBytes([state]) > MAX_RESOURCE_BYTES) {
      throw new RangeError("项目内嵌图片总大小超过限制");
    }
    return state;
  }

  function reduceEditorState(state, action) {
    if (!state || !action || typeof action.type !== "string") return state;

    switch (action.type) {
      case "toggleLine": {
        const index = Number(action.index);
        if (!Number.isInteger(index) || index < 0 || index >= state.document.lyrics.lines.length) return state;
        const selected = state.selectedLineIndices.includes(index);
        if (!selected && state.selectedLineIndices.length >= MAX_SELECTED_LINES) return state;
        const selectedLineIndices = selected
          ? state.selectedLineIndices.filter((item) => item !== index)
          : state.selectedLineIndices.concat(index).sort((a, b) => a - b);
        return { ...state, selectedLineIndices };
      }
      case "setLineText": {
        const index = Number(action.index);
        if (!state.selectedLineIndices.includes(index) || typeof action.text !== "string") return state;
        const original = state.document.lyrics.lines[index].text;
        const edits = { ...state.edits };
        if (action.text === original) delete edits[index];
        else edits[index] = action.text;
        return { ...state, edits };
      }
      case "setStyle": {
        if (!Object.prototype.hasOwnProperty.call(state.style, action.key)) return state;
        let value = action.value;
        if (action.key.endsWith("Color")) value = normalizeHexColor(value, state.style[action.key]);
        if (action.key === "backgroundTintedColor") value = value.slice(0, 7);
        if (action.key === "fontType" && !FONT_TYPES.includes(value)) return state;
        if (action.key === "textAlignment" && !TEXT_ALIGNMENTS.includes(value)) return state;
        if (action.key === "capsMode" && !CAPS_MODES.includes(value)) return state;
        if (state.style[action.key] === value) return state;
        return { ...state, style: { ...state.style, [action.key]: value } };
      }
      case "setPalette": {
        const backgroundColor = normalizeHexColor(action.backgroundColor, state.style.backgroundColor);
        const textColor = normalizeHexColor(action.textColor, state.style.textColor);
        if (backgroundColor === state.style.backgroundColor && textColor === state.style.textColor) return state;
        return { ...state, style: { ...state.style, backgroundColor, textColor } };
      }
      case "setMedia": {
        if (action.kind !== "background" && action.kind !== "cover") return state;
        const value = action.value === null ? null : normalizeMediaAsset(action.value);
        const media = { ...state.media, [action.kind]: value };
        if (action.kind === "background") media.useTrackArtworkAsBackground = false;
        return assertStateResourceBudget({ ...state, media });
      }
      case "addSticker": {
        if (state.stickers.length >= MAX_STICKERS) return state;
        const sticker = normalizeSticker(action.sticker);
        if (state.stickers.some((item) => item.id === sticker.id)) return state;
        return assertStateResourceBudget({ ...state, stickers: state.stickers.concat(sticker), activeStickerId: sticker.id });
      }
      case "replaceSticker": {
        const existing = state.stickers.find((item) => item.id === (action.sticker && action.sticker.id));
        if (!existing || action.sticker.imageData !== existing.imageData) return state;
        const sticker = normalizeSticker(action.sticker, true);
        const stickers = replaceSticker(state.stickers, sticker.id, () => sticker);
        return stickers === state.stickers ? state : { ...state, stickers };
      }
      case "removeSticker": {
        const stickers = state.stickers.filter((item) => item.id !== action.id);
        if (stickers.length === state.stickers.length) return state;
        return {
          ...state,
          stickers,
          activeStickerId: state.activeStickerId === action.id ? null : state.activeStickerId,
        };
      }
      case "selectSticker":
        return state.activeStickerId === action.id ? state : { ...state, activeStickerId: action.id || null };
      default:
        return state;
    }
  }

  function createHistory(initialState, options) {
    let current = initialState;
    let past = [];
    let future = [];
    const limit = Math.max(1, Number(options && options.limit) || HISTORY_LIMIT);
    const requestedResourceLimit = Number(options && options.resourceLimit);
    const resourceLimit = Number.isFinite(requestedResourceLimit) && requestedResourceLimit > 0
      ? requestedResourceLimit
      : MAX_HISTORY_RESOURCE_BYTES;

    function trimHistoryResources() {
      while (past.length && resourceStorageBytes(past.concat(current, future)) > resourceLimit) past.shift();
      while (future.length && resourceStorageBytes(past.concat(current, future)) > resourceLimit) future.pop();
    }

    return {
      get state() {
        return current;
      },
      get canUndo() {
        return past.length > 0;
      },
      get canRedo() {
        return future.length > 0;
      },
      execute(action) {
        const next = reduceEditorState(current, action);
        if (next === current) return current;
        past.push(current);
        if (past.length > limit) past = past.slice(past.length - limit);
        current = next;
        future = [];
        trimHistoryResources();
        return current;
      },
      replace(nextState) {
        if (!nextState || nextState === current) return current;
        past.push(current);
        if (past.length > limit) past = past.slice(past.length - limit);
        current = nextState;
        future = [];
        trimHistoryResources();
        return current;
      },
      setTransient(nextState) {
        if (nextState) current = nextState;
        return current;
      },
      undo() {
        if (!past.length) return current;
        future.unshift(current);
        current = past.pop();
        trimHistoryResources();
        return current;
      },
      redo() {
        if (!future.length) return current;
        past.push(current);
        current = future.shift();
        trimHistoryResources();
        return current;
      },
      reset(nextState) {
        current = nextState;
        past = [];
        future = [];
        return current;
      },
    };
  }

  function serializeState(state) {
    if (!state || !state.document || !Array.isArray(state.selectedLineIndices)) {
      throw new TypeError("editor state is invalid");
    }
    assertStateResourceBudget(state);
    const serialized = JSON.stringify({
      version: 1,
      document: state.document,
      selectedLineIndices: state.selectedLineIndices,
      edits: state.edits,
      style: state.style,
      media: state.media,
      stickers: state.stickers,
      activeStickerId: state.activeStickerId,
    });
    if (utf8ByteLength(serialized) > MAX_PROJECT_BYTES) throw new RangeError("项目文件大小超过限制");
    return serialized;
  }

  function restoreState(serialized) {
    let payload;
    if (typeof serialized === "string") {
      if (utf8ByteLength(serialized) > MAX_PROJECT_BYTES) throw new RangeError("项目文件大小超过限制");
      payload = JSON.parse(serialized);
    } else {
      const encoded = JSON.stringify(serialized);
      if (utf8ByteLength(encoded) > MAX_PROJECT_BYTES) throw new RangeError("项目文件大小超过限制");
      payload = serialized;
    }
    if (!isPlainObject(payload) || payload.version !== 1) {
      throw new TypeError("unsupported editor state version");
    }
    const document = normalizeDocument(payload.document);
    let state = createEditorState({
      document,
      selectedLineIndices: payload.selectedLineIndices,
      style: payload.style,
    });

    if (isPlainObject(payload.edits)) {
      Object.keys(payload.edits).forEach((key) => {
        const index = Number(key);
        if (typeof payload.edits[key] !== "string") return;
        state = reduceEditorState(state, { type: "setLineText", index, text: payload.edits[key] });
      });
    }
    if (isPlainObject(payload.media)) {
      ["background", "cover"].forEach((kind) => {
        const value = payload.media[kind];
        if (value === null || value === undefined) return;
        state = reduceEditorState(state, { type: "setMedia", kind, value });
      });
      if (typeof payload.media.useTrackArtworkAsBackground === "boolean") {
        state = {
          ...state,
          media: {
            ...state.media,
            useTrackArtworkAsBackground: payload.media.useTrackArtworkAsBackground
              && Boolean(state.document.track.coverUrl)
              && !state.media.background,
          },
        };
      }
    }
    if (Array.isArray(payload.stickers)) {
      if (payload.stickers.length > MAX_STICKERS) throw new RangeError(`最多添加 ${MAX_STICKERS} 个贴纸`);
      payload.stickers.forEach((sticker) => {
        state = reduceEditorState(state, { type: "addSticker", sticker });
      });
    }
    if (typeof payload.activeStickerId === "string" && state.stickers.some((item) => item.id === payload.activeStickerId)) {
      state = reduceEditorState(state, { type: "selectSticker", id: payload.activeStickerId });
    }
    return assertStateResourceBudget(state);
  }

  return Object.freeze({
    FONT_TYPES,
    TEXT_ALIGNMENTS,
    CAPS_MODES,
    MAX_SELECTED_LINES,
    MAX_STICKERS,
    MAX_IMAGE_BYTES,
    MAX_RESOURCE_BYTES,
    MAX_PROJECT_BYTES,
    MAX_HISTORY_RESOURCE_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    normalizeDocument,
    createEditorState,
    reduceEditorState,
    createHistory,
    getSelectedLines,
    selectedLineText,
    normalizeHexColor,
    utf8ByteLength,
    parseImageDataURL,
    validateImageDataURL,
    validateImageDimensions,
    imageDimensionsFromBytes,
    resourceStorageBytes,
    deepFreeze,
    serializeState,
    restoreState,
  });
});
