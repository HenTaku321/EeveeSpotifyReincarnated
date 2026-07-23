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
    lyricsTop: 84,
    lyricsBottom: 242,
    lyricMaxSize: 26,
    lyricMinSize: 13,
    lyricLineHeight: 1.08,
    lyricGroupGap: 4,
    footerBaseline: 272,
    footerSize: 8,
    footerMarkSize: 7,
    backgroundTintAlpha: 0.42,
    stickerHandleRadius: 4.5,
  });

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

  function tokensForWrap(text) {
    const tokens = String(text).match(/[\u3400-\u9fff]|\s+|[^\s\u3400-\u9fff]+/gu);
    return tokens && tokens.length ? tokens : [""];
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
      if (row) rows.push(row.trimEnd());
      row = token.trimStart();
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
    return rows.length ? rows : [""];
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

  function createLyricsLayout(ctx, state) {
    const width = LAYOUT.logicalSize - LAYOUT.margin * 2;
    const availableHeight = LAYOUT.lyricsBottom - LAYOUT.lyricsTop;
    const language = state.document.lyrics.language;
    const selected = State.getSelectedLines(state).map((line) => ({
      index: line.index,
      text: transformCaps(line.text, state.style.capsMode, language),
    }));

    for (let fontSize = LAYOUT.lyricMaxSize; fontSize >= LAYOUT.lyricMinSize; fontSize -= 1) {
      ctx.font = fontSpec(state.style.fontType, fontSize, 800);
      const lineHeight = fontSize * LAYOUT.lyricLineHeight;
      const groups = selected.map((line) => ({ ...line, rows: wrapText(ctx, line.text, width) }));
      const rowCount = groups.reduce((total, group) => total + Math.max(1, group.rows.length), 0);
      const height = rowCount * lineHeight + Math.max(0, groups.length - 1) * LAYOUT.lyricGroupGap;
      if (height <= availableHeight) {
        return { fontSize, lineHeight, groups, height, width };
      }
      if (fontSize === LAYOUT.lyricMinSize) {
        const gapHeight = Math.max(0, groups.length - 1) * LAYOUT.lyricGroupGap;
        const maxRows = Math.max(groups.length, Math.floor((availableHeight - gapHeight) / lineHeight));
        const allocations = groups.map(() => 1);
        let remaining = Math.max(0, maxRows - groups.length);
        while (remaining > 0) {
          let allocated = false;
          for (let index = 0; index < groups.length && remaining > 0; index += 1) {
            if (allocations[index] >= groups[index].rows.length) continue;
            allocations[index] += 1;
            remaining -= 1;
            allocated = true;
          }
          if (!allocated) break;
        }
        const fittedGroups = groups.map((group, index) => ({
          ...group,
          rows: limitWrappedRows(ctx, group.rows, allocations[index], width),
        }));
        const fittedRowCount = fittedGroups.reduce((total, group) => total + group.rows.length, 0);
        return {
          fontSize,
          lineHeight,
          groups: fittedGroups,
          height: fittedRowCount * lineHeight + gapHeight,
          width,
        };
      }
    }
    return { fontSize: LAYOUT.lyricMinSize, lineHeight: LAYOUT.lyricMinSize, groups: [], height: 0, width };
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

  function drawBackground(ctx, state, resources) {
    const size = LAYOUT.logicalSize;
    ctx.fillStyle = state.style.backgroundColor;
    ctx.fillRect(0, 0, size, size);
    const background = resourceImage(resources, "background");
    if (!background) return;
    const crop = fitCover(background.naturalWidth || background.width, background.naturalHeight || background.height, size, size);
    ctx.drawImage(background, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size);
    ctx.save();
    ctx.globalAlpha = LAYOUT.backgroundTintAlpha;
    ctx.fillStyle = state.style.backgroundTintedColor;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  function drawHeader(ctx, state, resources) {
    const rtl = state.document.lyrics.isRtlLanguage;
    const coverRect = rtl
      ? { x: LAYOUT.logicalSize - LAYOUT.margin - LAYOUT.coverSize, y: LAYOUT.headerTop, width: LAYOUT.coverSize, height: LAYOUT.coverSize }
      : { x: LAYOUT.margin, y: LAYOUT.headerTop, width: LAYOUT.coverSize, height: LAYOUT.coverSize };
    const cover = resourceImage(resources, "cover");
    if (cover) drawCoverImage(ctx, cover, coverRect, 4);
    else drawPlaceholderArtwork(ctx, coverRect, state.document.track.title);

    const textStart = rtl
      ? LAYOUT.margin
      : coverRect.x + coverRect.width + LAYOUT.headerGap;
    const textEnd = rtl
      ? coverRect.x - LAYOUT.headerGap
      : LAYOUT.logicalSize - LAYOUT.margin;
    const textWidth = textEnd - textStart;
    ctx.fillStyle = state.style.textColor;
    ctx.textAlign = rtl ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    const anchor = rtl ? textEnd : textStart;
    ctx.font = fontSpec("classic", LAYOUT.headerTitleSize, 800);
    ctx.fillText(truncateText(ctx, state.document.track.title, textWidth), anchor, LAYOUT.headerTop + 14);
    ctx.font = fontSpec("classic", LAYOUT.headerArtistSize, 500);
    ctx.globalAlpha = 0.82;
    ctx.fillText(truncateText(ctx, state.document.track.artist, textWidth), anchor, LAYOUT.headerTop + 29);
    ctx.globalAlpha = 1;
  }

  function drawLyrics(ctx, state) {
    const rtl = state.document.lyrics.isRtlLanguage;
    const alignment = resolveAlignment(state.style.textAlignment, rtl);
    const layout = createLyricsLayout(ctx, state);
    const x = alignment === "center"
      ? LAYOUT.logicalSize / 2
      : alignment === "right"
        ? LAYOUT.logicalSize - LAYOUT.margin
        : LAYOUT.margin;
    let y = LAYOUT.lyricsTop;

    ctx.fillStyle = state.style.textColor;
    ctx.textAlign = alignment;
    ctx.textBaseline = "top";
    ctx.font = fontSpec(state.style.fontType, layout.fontSize, 800);
    layout.groups.forEach((group, groupIndex) => {
      group.rows.forEach((row) => {
        const clipped = y + layout.lineHeight > LAYOUT.lyricsBottom
          ? truncateText(ctx, row, layout.width)
          : row;
        if (y < LAYOUT.lyricsBottom) ctx.fillText(clipped, x, y);
        y += layout.lineHeight;
      });
      if (groupIndex < layout.groups.length - 1) y += LAYOUT.lyricGroupGap;
    });
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

  function drawFooter(ctx, state) {
    const source = state.document.lyrics.provider && state.document.lyrics.provider !== "github"
      ? `GitHub · ${state.document.lyrics.provider}`
      : "GitHub Lyrics";
    ctx.save();
    ctx.fillStyle = state.style.textColor;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.font = fontSpec("classic", LAYOUT.footerMarkSize, 800);
    ctx.beginPath();
    ctx.arc(LAYOUT.margin + 4, LAYOUT.footerBaseline - 3, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(LAYOUT.margin + 5, LAYOUT.footerBaseline - 4, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.font = fontSpec("classic", LAYOUT.footerSize, 800);
    ctx.fillText(source, LAYOUT.margin + 13, LAYOUT.footerBaseline);
    ctx.restore();
  }

  function renderToCanvas(canvas, state, resources, options) {
    if (!state || !state.document) throw new TypeError("editor state is required");
    const dimensions = prepareCanvas(canvas, options && options.scale);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is unavailable");
    ctx.setTransform(dimensions.scale, 0, 0, dimensions.scale, 0, 0);
    ctx.clearRect(0, 0, LAYOUT.logicalSize, LAYOUT.logicalSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    drawBackground(ctx, state, resources);
    drawHeader(ctx, state, resources);
    const lyricsLayout = drawLyrics(ctx, state);
    state.stickers.forEach((sticker) => {
      drawSticker(
        ctx,
        sticker,
        resourceImage(resources && resources.stickers, sticker.id),
        Boolean(options && options.showSelection && sticker.id === state.activeStickerId),
      );
    });
    drawFooter(ctx, state);
    return { dimensions, lyricsLayout };
  }

  return Object.freeze({
    LAYOUT,
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
