(function (root, factory) {
  "use strict";

  const stateApi = typeof module === "object" && module.exports
    ? require("./editor-state.js")
    : root.ShareEditorState;
  const api = factory(stateApi);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShareEditorRenderer = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (State) {
  "use strict";

  if (!State) throw new Error("ShareEditorState is required");

  const LAYOUT = Object.freeze({
    logicalSize: 297,
    outputScale: 3,
    margin: 24,
    coverSize: 32,
    headerGap: 10,
    headerTitleSize: 11,
    headerArtistSize: 9,
    headerTop: 24,
    // Behavior switches. Their LAYOUT values describe today's skeleton layout;
    // templates override them ("none"/"compact", "hairline"/"trackline",
    // "coverBleed").
    header: "default",
    footer: "default",
    backgroundMode: "color",
    headerTitleBaselineOffset: 14,
    headerArtistBaselineOffset: 29,
    compactTitleSize: 9,
    compactArtistSize: 7.5,
    compactTitleBaselineOffset: 11,
    compactArtistBaselineOffset: 23,
    lyricsTop: 84,
    lyricsBottom: 242,
    lyricMaxSize: 26,
    lyricMinSize: 13,
    lyricLineHeight: 1.08,
    translationScale: 0.52,
    translationLineHeight: 1.1,
    translationGap: 1,
    lyricGroupGap: 4,
    footerBaseline: 272,
    footerSize: 8,
    footerMarkSize: 7,
    footerMarkOffsetX: 4,
    footerMarkOffsetY: -3,
    footerMarkRadius: 4,
    footerMarkInnerOffsetX: 5,
    footerMarkInnerOffsetY: -4,
    footerMarkInnerRadius: 1.5,
    footerTextOffsetX: 13,
    footerHairlineY: 260,
    footerHairlineAlpha: 0.24,
    footerHairlineTextSize: 6.5,
    footerHairlineTextAlpha: 0.7,
    footerTrackCoverSize: 12,
    footerTrackCoverRadius: 2.5,
    footerTrackCoverTop: 263,
    footerTrackTextGap: 5,
    footerTrackTitleSize: 7,
    footerTrackTextAlpha: 0.7,
    footerTrackSourceGap: 8,
    backgroundTintAlpha: 0.42,
    stickerHandleRadius: 4.5,
  });

  const TEMPLATES = Object.freeze({
    // Regression anchor: skeleton must stay an empty override so it renders
    // exactly like the pre-template layout (LAYOUT is the single source).
    skeleton: Object.freeze({}),
    lyrics: Object.freeze({
      header: "none",
      footer: "trackline",
      lyricsTop: 36,
      lyricsBottom: 250,
      lyricMaxSize: 64,
    }),
    poster: Object.freeze({
      header: "compact",
      footer: "hairline",
      backgroundMode: "coverBleed",
      lyricsTop: 96,
      lyricsBottom: 252,
    }),
  });

  function resolveTemplate(name) {
    return Object.freeze({ ...LAYOUT, ...(TEMPLATES[name] || TEMPLATES.lyrics) });
  }

  const FONT_FAMILIES = Object.freeze({
    classic: 'Arial, Helvetica, sans-serif',
    wide: 'Arial Black, Helvetica, sans-serif',
    narrow: 'Arial Narrow, Helvetica Condensed, sans-serif',
    slanted: 'Georgia, Times New Roman, serif',
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function outputDimensions(scale) {
    const resolvedScale = Number(scale) || LAYOUT.outputScale;
    return {
      logicalWidth: LAYOUT.logicalSize,
      logicalHeight: LAYOUT.logicalSize,
      scale: resolvedScale,
      width: Math.round(LAYOUT.logicalSize * resolvedScale),
      height: Math.round(LAYOUT.logicalSize * resolvedScale),
    };
  }

  function prepareCanvas(canvas, scale) {
    if (!canvas || typeof canvas.getContext !== "function") throw new TypeError("canvas is required");
    const dimensions = outputDimensions(scale);
    if (canvas.width !== dimensions.width) canvas.width = dimensions.width;
    if (canvas.height !== dimensions.height) canvas.height = dimensions.height;
    return dimensions;
  }

  function fitCover(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const sw = Math.max(1, Number(sourceWidth) || 1);
    const sh = Math.max(1, Number(sourceHeight) || 1);
    const tw = Math.max(1, Number(targetWidth) || 1);
    const th = Math.max(1, Number(targetHeight) || 1);
    const scale = Math.max(tw / sw, th / sh);
    const width = tw / scale;
    const height = th / scale;
    return {
      sx: (sw - width) / 2,
      sy: (sh - height) / 2,
      sw: width,
      sh: height,
      dx: 0,
      dy: 0,
      dw: tw,
      dh: th,
    };
  }

  function resolveAlignment(alignment, isRtl) {
    if (alignment === "center") return "center";
    if (alignment === "leading") return isRtl ? "right" : "left";
    if (alignment === "trailing") return isRtl ? "left" : "right";
    return isRtl ? "right" : "left";
  }

  function fontSpec(fontType, size, weight) {
    const family = FONT_FAMILIES[fontType] || FONT_FAMILIES.classic;
    const style = fontType === "slanted" ? "italic " : "";
    return `${style}${weight || 800} ${size}px ${family}`;
  }

  function transformCaps(text, capsMode, language) {
    if (capsMode !== "allCaps") return text;
    try {
      return language ? text.toLocaleUpperCase(language) : text.toLocaleUpperCase();
    } catch (_error) {
      return text.toUpperCase();
    }
  }

  // CJK glyphs wrap per character: CJK punctuation (U+3000-U+303F), kana
  // (U+3040-U+30FF), unified ideographs (U+3400-U+9FFF), and halfwidth/
  // fullwidth forms (U+FF00-U+FFEF).
  const CJK_CHAR = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/u;

  // Kinsoku shori: closing punctuation must not start a line, opening
  // punctuation must not end one.
  const LINE_START_FORBIDDEN = new Set(Array.from("\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff01\uff09\u3011\u300b\u3009\u300d\u300f\u3015\u3017\u3019\u301b\u201d\u2019\u2026\u2025\uff05\u2030\uff5e\u30fb\u3005\u30fc!%),.:;?]}"));
  const LINE_END_FORBIDDEN = new Set(Array.from("\uff08\u3010\u300a\u3008\u300c\u300e\u3014\u3016\u3018\u301a\u201c\u2018([{"));

  function firstChar(value) {
    const step = value[Symbol.iterator]().next();
    return step.done ? "" : step.value;
  }

  function lastChar(value) {
    const characters = Array.from(value);
    return characters.length ? characters[characters.length - 1] : "";
  }

  function dropLastChar(value) {
    const characters = Array.from(value);
    characters.pop();
    return characters.join("");
  }

  function tokensForWrap(text) {
    const tokens = String(text)
      .match(/[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]|\s+|[^\s\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]+/gu);
    return tokens && tokens.length ? tokens : [""];
  }

  // When a break would leave forbidden punctuation at a line boundary, move
  // the punctuation together with its preceding character to the next line.
  function adjustLineBreak(head, tail) {
    let nextHead = head;
    let nextTail = tail;
    while (Array.from(nextHead).length > 1
      && (LINE_START_FORBIDDEN.has(firstChar(nextTail)) || LINE_END_FORBIDDEN.has(lastChar(nextHead)))) {
      nextTail = lastChar(nextHead) + nextTail;
      nextHead = dropLastChar(nextHead).trimEnd();
    }
    return { head: nextHead, tail: nextTail };
  }

  // Widow protection: if wrapping strands a single CJK character on the last
  // row, pull one more character down so the last row keeps at least two.
  function fixWidowRow(rows) {
    if (rows.length < 2) return rows;
    const last = rows[rows.length - 1];
    const lastCharacters = Array.from(last);
    if (lastCharacters.length !== 1 || !CJK_CHAR.test(lastCharacters[0])) return rows;
    let head = rows[rows.length - 2];
    if (Array.from(head).length <= 1) return rows;
    let tail = lastChar(head) + last;
    head = dropLastChar(head).trimEnd();
    const adjusted = adjustLineBreak(head, tail);
    if (!adjusted.head) return rows;
    rows[rows.length - 2] = adjusted.head;
    rows[rows.length - 1] = adjusted.tail;
    return rows;
  }

  function wrapText(ctx, text, maxWidth) {
    const tokens = tokensForWrap(text);
    const rows = [];
    let row = "";

    tokens.forEach((token) => {
      const candidate = row + token;
      if (row && ctx.measureText(candidate).width <= maxWidth) {
        row = candidate;
        return;
      }
      if (row) {
        const adjusted = adjustLineBreak(row.trimEnd(), token.trimStart());
        if (adjusted.head) rows.push(adjusted.head);
        row = adjusted.tail;
      } else {
        row = token.trimStart();
      }
      if (!row || ctx.measureText(row).width <= maxWidth) return;

      let fragment = "";
      Array.from(row).forEach((character) => {
        if (fragment && ctx.measureText(fragment + character).width > maxWidth) {
          rows.push(fragment);
          fragment = character;
        } else {
          fragment += character;
        }
      });
      row = fragment;
    });
    rows.push(row.trimEnd());
    return fixWidowRow(rows.length ? rows : [""]);
  }

  function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis = "…";
    let value = text;
    while (value && ctx.measureText(value + ellipsis).width > maxWidth) {
      value = value.slice(0, -1);
    }
    return value + ellipsis;
  }

  function limitWrappedRows(ctx, rows, maxRows, maxWidth) {
    if (rows.length <= maxRows) return rows;
    if (maxRows < 1) return [];
    const visible = rows.slice(0, maxRows);
    visible[maxRows - 1] = truncateText(ctx, `${visible[maxRows - 1]}…`, maxWidth);
    return visible;
  }

  function createLyricsLayout(ctx, state, metrics) {
    const M = metrics || resolveTemplate(state.template);
    const width = M.logicalSize - M.margin * 2;
    const availableHeight = M.lyricsBottom - M.lyricsTop;
    const language = state.document.lyrics.language;
    const selected = State.getSelectedLines(state).map((line) => ({
      index: line.index,
      text: transformCaps(line.text, state.style.capsMode, language),
      base: transformCaps(line.base, state.style.capsMode, language),
      translation: transformCaps(line.translation, state.style.capsMode, language),
    }));

    const measure = (fontSize) => {
      const translationFontSize = Math.max(6, fontSize * M.translationScale);
      const lineHeight = fontSize * M.lyricLineHeight;
      const translationLineHeight = translationFontSize * M.translationLineHeight;
      ctx.font = fontSpec(state.style.fontType, fontSize, 800);
      const groups = selected.map((line) => ({ ...line, rows: wrapText(ctx, line.base, width) }));
      ctx.font = fontSpec(state.style.fontType, translationFontSize, 600);
      groups.forEach((group) => {
        group.translationRows = group.translation ? wrapText(ctx, group.translation, width) : [];
      });
      const height = groups.reduce((total, group) => total
        + Math.max(1, group.rows.length) * lineHeight
        + (group.translationRows.length
          ? M.translationGap + group.translationRows.length * translationLineHeight
          : 0), 0)
        + Math.max(0, groups.length - 1) * M.lyricGroupGap;
      return { fontSize, lineHeight, translationFontSize, translationLineHeight, groups, height, width };
    };

    // Binary search on a 0.5px grid for the largest font size that fits the
    // lyrics band (~6 iterations instead of a 1px linear scan).
    const largest = measure(M.lyricMaxSize);
    if (largest.height <= availableHeight) return largest;
    const smallest = measure(M.lyricMinSize);
    if (smallest.height <= availableHeight) {
      let fitting = smallest;
      let lo = M.lyricMinSize;
      let hi = M.lyricMaxSize;
      while (hi - lo > 0.5) {
        const mid = Math.round(lo + hi) / 2;
        const candidate = measure(mid);
        if (candidate.height <= availableHeight) {
          fitting = candidate;
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return fitting;
    }

    // Even the minimum size overflows: allocate row quotas and truncate.
    const { fontSize, lineHeight, translationFontSize, translationLineHeight, groups } = smallest;
    const gapHeight = Math.max(0, groups.length - 1) * M.lyricGroupGap;
    const allocations = groups.map((group) => ({ base: 1, translation: group.translationRows.length ? 1 : 0 }));
    const minimumHeight = allocations.reduce((total, allocation) => total
      + allocation.base * lineHeight
      + (allocation.translation ? M.translationGap + allocation.translation * translationLineHeight : 0), gapHeight);
    let remainingHeight = Math.max(0, availableHeight - minimumHeight);
    while (remainingHeight > 0) {
      let allocated = false;
      for (let index = 0; index < groups.length; index += 1) {
        if (allocations[index].base < groups[index].rows.length && remainingHeight >= lineHeight) {
          allocations[index].base += 1;
          remainingHeight -= lineHeight;
          allocated = true;
        }
        if (allocations[index].translation < groups[index].translationRows.length
          && remainingHeight >= translationLineHeight) {
          allocations[index].translation += 1;
          remainingHeight -= translationLineHeight;
          allocated = true;
        }
      }
      if (!allocated) break;
    }
    const fittedGroups = groups.map((group, index) => {
      ctx.font = fontSpec(state.style.fontType, fontSize, 800);
      const rows = limitWrappedRows(ctx, group.rows, allocations[index].base, width);
      ctx.font = fontSpec(state.style.fontType, translationFontSize, 600);
      const translationRows = limitWrappedRows(ctx, group.translationRows, allocations[index].translation, width);
      return { ...group, rows, translationRows };
    });
    const fittedHeight = fittedGroups.reduce((total, group) => total
      + group.rows.length * lineHeight
      + (group.translationRows.length
        ? M.translationGap + group.translationRows.length * translationLineHeight
        : 0), gapHeight);
    return {
      fontSize,
      lineHeight,
      translationFontSize,
      translationLineHeight,
      groups: fittedGroups,
      height: fittedHeight,
      width,
    };
  }

  function stickerGeometry(sticker) {
    const width = clamp(sticker.normalizedSize.width, 0.02, 1) * LAYOUT.logicalSize;
    const height = clamp(sticker.normalizedSize.height, 0.02, 1) * LAYOUT.logicalSize;
    const centerX = clamp(sticker.normalizedCenter.x, 0, 1) * LAYOUT.logicalSize;
    const centerY = clamp(sticker.normalizedCenter.y, 0, 1) * LAYOUT.logicalSize;
    return {
      centerX,
      centerY,
      width,
      height,
      rotation: Number(sticker.rotation) || 0,
      left: centerX - width / 2,
      top: centerY - height / 2,
    };
  }

  function rotatePoint(point, center, radians) {
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cosine - dy * sine,
      y: center.y + dx * sine + dy * cosine,
    };
  }

  function stickerHandlePoint(sticker) {
    const geometry = stickerGeometry(sticker);
    return rotatePoint(
      { x: geometry.centerX + geometry.width / 2, y: geometry.centerY + geometry.height / 2 },
      { x: geometry.centerX, y: geometry.centerY },
      geometry.rotation,
    );
  }

  function pointInSticker(sticker, point) {
    const geometry = stickerGeometry(sticker);
    const local = rotatePoint(
      point,
      { x: geometry.centerX, y: geometry.centerY },
      -geometry.rotation,
    );
    return Math.abs(local.x - geometry.centerX) <= geometry.width / 2
      && Math.abs(local.y - geometry.centerY) <= geometry.height / 2;
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, width, height, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function drawCoverImage(ctx, image, rect, radius) {
    ctx.save();
    ctx.beginPath();
    const r = Math.min(radius, rect.width / 2, rect.height / 2);
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, r);
    ctx.clip();
    const crop = fitCover(image.naturalWidth || image.width, image.naturalHeight || image.height, rect.width, rect.height);
    ctx.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  function drawPlaceholderArtwork(ctx, rect, title) {
    ctx.save();
    ctx.fillStyle = "#18211d";
    ctx.beginPath();
    roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 4);
    ctx.fill();
    ctx.fillStyle = "#a7f3c8";
    ctx.font = "700 15px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const mark = Array.from(String(title || "♪").trim())[0] || "♪";
    ctx.fillText(mark.toLocaleUpperCase(), rect.x + rect.width / 2, rect.y + rect.height / 2 + 0.5);
    ctx.restore();
  }

  function resourceImage(resources, key) {
    if (!resources) return null;
    const value = resources instanceof Map ? resources.get(key) : resources[key];
    return value && (value.complete === undefined || value.complete) ? value : null;
  }

  function resolveCoverLuma(resources) {
    const value = resources instanceof Map
      ? resources.get("coverLuma")
      : resources
        ? resources.coverLuma
        : undefined;
    return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : null;
  }

  function drawBackground(ctx, state, resources, metrics) {
    const M = metrics || resolveTemplate(state.template);
    const size = M.logicalSize;
    ctx.fillStyle = state.style.backgroundColor;
    ctx.fillRect(0, 0, size, size);
    if (M.backgroundMode === "coverBleed") {
      const bleed = resourceImage(resources, "cover") || resourceImage(resources, "background");
      // Without any artwork the plain colored background above stays as-is.
      if (!bleed) return;
      const crop = fitCover(bleed.naturalWidth || bleed.width, bleed.naturalHeight || bleed.height, size, size);
      ctx.drawImage(bleed, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size);
      // Vertical scrim, darker at the bottom. Bright covers (luma → 1) get a
      // lighter scrim, dark covers a stronger one; without a sampled luma the
      // legacy fixed tint alpha applies.
      const luma = resolveCoverLuma(resources);
      const baseAlpha = luma === null
        ? M.backgroundTintAlpha
        : clamp(0.28 + 0.5 * (1 - luma), 0.28, 0.72);
      const gradient = ctx.createLinearGradient(0, 0, 0, size);
      gradient.addColorStop(0, `rgba(0,0,0,${(baseAlpha * 0.4).toFixed(4)})`);
      gradient.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, baseAlpha + 0.16).toFixed(4)})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      return;
    }
    const background = resourceImage(resources, "background");
    if (!background) return;
    const crop = fitCover(background.naturalWidth || background.width, background.naturalHeight || background.height, size, size);
    ctx.drawImage(background, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size);
    ctx.save();
    ctx.globalAlpha = M.backgroundTintAlpha;
    ctx.fillStyle = state.style.backgroundTintedColor;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  function drawHeader(ctx, state, resources, metrics) {
    const M = metrics || resolveTemplate(state.template);
    if (M.header === "none") return;
    const rtl = state.document.lyrics.isRtlLanguage;
    if (M.header === "compact") {
      const textStart = M.margin;
      const textEnd = M.logicalSize - M.margin;
      const textWidth = textEnd - textStart;
      const anchor = rtl ? textEnd : textStart;
      ctx.fillStyle = state.style.textColor;
      ctx.textAlign = rtl ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = fontSpec("classic", M.compactTitleSize, 800);
      ctx.fillText(truncateText(ctx, state.document.track.title, textWidth), anchor, M.headerTop + M.compactTitleBaselineOffset);
      ctx.font = fontSpec("classic", M.compactArtistSize, 500);
      ctx.globalAlpha = 0.82;
      ctx.fillText(truncateText(ctx, state.document.track.artist, textWidth), anchor, M.headerTop + M.compactArtistBaselineOffset);
      ctx.globalAlpha = 1;
      return;
    }
    const coverRect = rtl
      ? { x: M.logicalSize - M.margin - M.coverSize, y: M.headerTop, width: M.coverSize, height: M.coverSize }
      : { x: M.margin, y: M.headerTop, width: M.coverSize, height: M.coverSize };
    const cover = resourceImage(resources, "cover");
    if (cover) drawCoverImage(ctx, cover, coverRect, 4);
    else drawPlaceholderArtwork(ctx, coverRect, state.document.track.title);

    const textStart = rtl
      ? M.margin
      : coverRect.x + coverRect.width + M.headerGap;
    const textEnd = rtl
      ? coverRect.x - M.headerGap
      : M.logicalSize - M.margin;
    const textWidth = textEnd - textStart;
    ctx.fillStyle = state.style.textColor;
    ctx.textAlign = rtl ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    const anchor = rtl ? textEnd : textStart;
    ctx.font = fontSpec("classic", M.headerTitleSize, 800);
    ctx.fillText(truncateText(ctx, state.document.track.title, textWidth), anchor, M.headerTop + M.headerTitleBaselineOffset);
    ctx.font = fontSpec("classic", M.headerArtistSize, 500);
    ctx.globalAlpha = 0.82;
    ctx.fillText(truncateText(ctx, state.document.track.artist, textWidth), anchor, M.headerTop + M.headerArtistBaselineOffset);
    ctx.globalAlpha = 1;
  }

  function drawLyrics(ctx, state, metrics) {
    const M = metrics || resolveTemplate(state.template);
    const rtl = state.document.lyrics.isRtlLanguage;
    const alignment = resolveAlignment(state.style.textAlignment, rtl);
    const layout = createLyricsLayout(ctx, state, M);
    const x = alignment === "center"
      ? M.logicalSize / 2
      : alignment === "right"
        ? M.logicalSize - M.margin
        : M.margin;
    let y = M.lyricsTop;

    ctx.fillStyle = state.style.textColor;
    ctx.textAlign = alignment;
    ctx.textBaseline = "top";
    layout.groups.forEach((group, groupIndex) => {
      ctx.globalAlpha = 1;
      ctx.font = fontSpec(state.style.fontType, layout.fontSize, 800);
      group.rows.forEach((row) => {
        const clipped = y + layout.lineHeight > M.lyricsBottom
          ? truncateText(ctx, row, layout.width)
          : row;
        if (y < M.lyricsBottom) ctx.fillText(clipped, x, y);
        y += layout.lineHeight;
      });
      if (group.translationRows.length) {
        y += M.translationGap;
        ctx.globalAlpha = 0.78;
        ctx.font = fontSpec(state.style.fontType, layout.translationFontSize, 600);
        group.translationRows.forEach((row) => {
          const clipped = y + layout.translationLineHeight > M.lyricsBottom
            ? truncateText(ctx, row, layout.width)
            : row;
          if (y < M.lyricsBottom) ctx.fillText(clipped, x, y);
          y += layout.translationLineHeight;
        });
      }
      if (groupIndex < layout.groups.length - 1) y += M.lyricGroupGap;
    });
    ctx.globalAlpha = 1;
    return layout;
  }

  function drawSticker(ctx, sticker, image, selected) {
    if (!image) return;
    const geometry = stickerGeometry(sticker);
    ctx.save();
    ctx.translate(geometry.centerX, geometry.centerY);
    ctx.rotate(geometry.rotation);
    ctx.drawImage(image, -geometry.width / 2, -geometry.height / 2, geometry.width, geometry.height);
    if (selected) {
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(-geometry.width / 2, -geometry.height / 2, geometry.width, geometry.height);
    }
    ctx.restore();
    if (selected) {
      const handle = stickerHandlePoint(sticker);
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#121614";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, LAYOUT.stickerHandleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Lyrics-template footer: below the hairline sits one strip with a small
  // rounded cover chip, "Title · Artist" on the leading side, and the source
  // label on the trailing side. Without cover art the chip is skipped (no
  // placeholder) and the track text moves to the margin. RTL mirrors the row.
  function drawTrackFooter(ctx, state, resources, M, source) {
    const rtl = state.document.lyrics.isRtlLanguage;
    ctx.fillStyle = `rgba(255,255,255,${M.footerHairlineAlpha})`;
    ctx.fillRect(M.margin, M.footerHairlineY, M.logicalSize - M.margin * 2, 1);

    const cover = resourceImage(resources, "cover");
    if (cover) {
      const chipX = rtl ? M.logicalSize - M.margin - M.footerTrackCoverSize : M.margin;
      drawCoverImage(ctx, cover, {
        x: chipX,
        y: M.footerTrackCoverTop,
        width: M.footerTrackCoverSize,
        height: M.footerTrackCoverSize,
      }, M.footerTrackCoverRadius);
    }

    // The trailing source label is measured first so the track text can be
    // truncated before it ever reaches the label.
    ctx.fillStyle = state.style.textColor;
    ctx.textBaseline = "alphabetic";
    ctx.font = fontSpec("classic", M.footerHairlineTextSize, 600);
    const sourceWidth = ctx.measureText(source).width;
    ctx.globalAlpha = M.footerHairlineTextAlpha;
    ctx.textAlign = rtl ? "left" : "right";
    ctx.fillText(source, rtl ? M.margin : M.logicalSize - M.margin, M.footerBaseline);
    ctx.globalAlpha = 1;

    const chipInset = cover ? M.footerTrackCoverSize + M.footerTrackTextGap : 0;
    let remaining = M.logicalSize - M.margin * 2 - chipInset - sourceWidth - M.footerTrackSourceGap;
    if (remaining <= 0) return;
    let cursor = rtl ? M.logicalSize - M.margin - chipInset : M.margin + chipInset;
    ctx.textAlign = rtl ? "right" : "left";
    const title = state.document.track.title;
    const artist = state.document.track.artist;
    if (title) {
      ctx.font = fontSpec("classic", M.footerTrackTitleSize, 700);
      const clipped = truncateText(ctx, title, remaining);
      ctx.fillText(clipped, cursor, M.footerBaseline);
      const width = ctx.measureText(clipped).width;
      cursor += rtl ? -width : width;
      remaining -= width;
    }
    // Skip the artist entirely when less than roughly one glyph fits.
    if (!artist || remaining < M.footerTrackTitleSize) return;
    const segment = title ? (rtl ? `${artist} · ` : ` · ${artist}`) : artist;
    ctx.font = fontSpec("classic", M.footerTrackTitleSize, 500);
    ctx.globalAlpha = M.footerTrackTextAlpha;
    ctx.fillText(truncateText(ctx, segment, remaining), cursor, M.footerBaseline);
    ctx.globalAlpha = 1;
  }

  function drawFooter(ctx, state, resources, metrics) {
    const M = metrics || resolveTemplate(state.template);
    const source = state.document.lyrics.provider && state.document.lyrics.provider !== "github"
      ? `GitHub · ${state.document.lyrics.provider}`
      : "GitHub Lyrics";
    ctx.save();
    if (M.footer === "trackline") {
      drawTrackFooter(ctx, state, resources, M, source);
      ctx.restore();
      return;
    }
    if (M.footer === "hairline") {
      // A one-pixel hairline in low-opacity white plus a tiny source label.
      ctx.fillStyle = `rgba(255,255,255,${M.footerHairlineAlpha})`;
      ctx.fillRect(M.margin, M.footerHairlineY, M.logicalSize - M.margin * 2, 1);
      ctx.fillStyle = state.style.textColor;
      ctx.globalAlpha = M.footerHairlineTextAlpha;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.font = fontSpec("classic", M.footerHairlineTextSize, 600);
      ctx.fillText(source, M.margin, M.footerBaseline);
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }
    ctx.fillStyle = state.style.textColor;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.font = fontSpec("classic", M.footerMarkSize, 800);
    ctx.beginPath();
    ctx.arc(M.margin + M.footerMarkOffsetX, M.footerBaseline + M.footerMarkOffsetY, M.footerMarkRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(M.margin + M.footerMarkInnerOffsetX, M.footerBaseline + M.footerMarkInnerOffsetY, M.footerMarkInnerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.font = fontSpec("classic", M.footerSize, 800);
    ctx.fillText(source, M.margin + M.footerTextOffsetX, M.footerBaseline);
    ctx.restore();
  }

  function renderToCanvas(canvas, state, resources, options) {
    if (!state || !state.document) throw new TypeError("editor state is required");
    const metrics = resolveTemplate(state.template);
    const dimensions = prepareCanvas(canvas, options && options.scale);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is unavailable");
    ctx.setTransform(dimensions.scale, 0, 0, dimensions.scale, 0, 0);
    ctx.clearRect(0, 0, metrics.logicalSize, metrics.logicalSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    drawBackground(ctx, state, resources, metrics);
    drawHeader(ctx, state, resources, metrics);
    const lyricsLayout = drawLyrics(ctx, state, metrics);
    state.stickers.forEach((sticker) => {
      drawSticker(
        ctx,
        sticker,
        resourceImage(resources && resources.stickers, sticker.id),
        Boolean(options && options.showSelection && sticker.id === state.activeStickerId),
      );
    });
    drawFooter(ctx, state, resources, metrics);
    return { dimensions, lyricsLayout };
  }

  return Object.freeze({
    LAYOUT,
    TEMPLATES,
    resolveTemplate,
    FONT_FAMILIES,
    outputDimensions,
    prepareCanvas,
    fitCover,
    resolveAlignment,
    transformCaps,
    wrapText,
    createLyricsLayout,
    stickerGeometry,
    stickerHandlePoint,
    pointInSticker,
    renderToCanvas,
  });
});
