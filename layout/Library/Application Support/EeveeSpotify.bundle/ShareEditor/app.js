(function (root, factory) {
  "use strict";

  const State = typeof module === "object" && module.exports
    ? require("./editor-state.js")
    : root.ShareEditorState;
  const Renderer = typeof module === "object" && module.exports
    ? require("./renderer.js")
    : root.ShareEditorRenderer;
  const RepositorySource = typeof module === "object" && module.exports
    ? require("./repository-source.js")
    : root.LyricsRepositorySource;
  const Icons = typeof module === "object" && module.exports
    ? require("./icons.js")
    : root.LyricsEditorIcons;
  const api = factory(root, State, Renderer, RepositorySource, Icons);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShareEditor = Object.assign(root.ShareEditor || {}, api.publicApi);
  }
  if (root && root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", api.mount, { once: true });
    } else {
      api.mount();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, State, Renderer, RepositorySource, Icons) {
  "use strict";

  if (!State || !Renderer) throw new Error("ShareEditor state and renderer are required");

  const ENDPOINT = "/v1/share-editor/lyrics";
  const MAX_IMAGE_BYTES = State.MAX_IMAGE_BYTES;
  const MAX_PROJECT_BYTES = State.MAX_PROJECT_BYTES;
  const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
  const MAX_PREVIEW_CSS_SIZE = 560;
  const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const DEMO_DOCUMENT = Object.freeze({
    source: "github",
    hash: "",
    track: {
      trackId: "demo",
      title: "夜色与回声",
      artist: "GitHub Lyrics",
      album: "Share Editor",
      coverUrl: "",
    },
    lyrics: {
      syncType: "LINE_SYNCED",
      provider: "github",
      language: "zh",
      isRtlLanguage: false,
      lines: [
        { startTimeMs: "0", words: "灯光落在安静的街角", endTimeMs: "3200" },
        { startTimeMs: "3200", words: "我们把未说完的话写成歌", endTimeMs: "6800" },
        { startTimeMs: "6800", words: "让每一次回声都有颜色", endTimeMs: "10100" },
        { startTimeMs: "10100", words: "在天亮以前慢慢经过", endTimeMs: "13800" },
        { startTimeMs: "13800", words: "下一行仍然可以重新编辑", endTimeMs: "17200" },
        { startTimeMs: "17200", words: "最后只留下属于你的画面", endTimeMs: "21000" },
      ],
      alternatives: [],
    },
    colors: {
      background: "#498cb7",
      text: "#05090e",
      highlightText: "#ffffff",
    },
    selectedLineIndices: [0, 1, 2, 3],
  });

  let mountedController = null;
  let pendingDocument = null;
  let pendingState = null;

  function createDocumentGateway(options) {
    const fetchImpl = options && options.fetchImpl;
    const applyDocument = options && options.applyDocument;
    const endpoint = options && options.endpoint ? options.endpoint : ENDPOINT;
    if (typeof applyDocument !== "function") throw new TypeError("applyDocument is required");

    return Object.freeze({
      loadDocument(document) {
        return Promise.resolve(applyDocument(document));
      },
      async fetchFromServer(query, token) {
        if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
        const track = query && query.track;
        if (!track || typeof track.trackId !== "string" || !track.trackId.trim()) {
          throw new TypeError("track.trackId is required");
        }
        const headers = { "Content-Type": "application/json", Accept: "application/json" };
        if (typeof token === "string" && token) headers["X-MITM-Lyrics-Token"] = token;
        const response = await fetchImpl(endpoint, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers,
          body: JSON.stringify({
            track: {
              trackId: track.trackId.trim(),
              title: typeof track.title === "string" ? track.title.trim() : "",
              artist: typeof track.artist === "string" ? track.artist.trim() : "",
              album: typeof track.album === "string" ? track.album.trim() : "",
            },
            ...(typeof query.hash === "string" && query.hash ? { hash: query.hash } : {}),
          }),
        });
        let payload;
        try {
          const contentLength = Number(response.headers && response.headers.get("Content-Length"));
          if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
            throw new RangeError("歌词响应大小超过限制");
          }
          const body = await response.text();
          if (State.utf8ByteLength(body) > MAX_DOCUMENT_BYTES) throw new RangeError("歌词响应大小超过限制");
          payload = JSON.parse(body);
        } catch (_error) {
          if (_error instanceof RangeError) throw _error;
          throw new Error("歌词服务返回了无效 JSON");
        }
        if (!response.ok || !payload || payload.ok === false) {
          throw new Error(payload && payload.error ? String(payload.error) : `歌词载入失败 (${response.status})`);
        }
        return payload;
      },
      async loadFromServer(query, token) {
        return applyDocument(await this.fetchFromServer(query, token));
      },
    });
  }

  function safeImageSource(source) {
    if (typeof source !== "string" || !source) return false;
    if (/^data:image\/(png|jpeg|webp);base64,/i.test(source)) {
      try {
        State.validateImageDataURL(source);
        return true;
      } catch (_error) {
        return false;
      }
    }
    if (/^blob:/i.test(source)) return true;
    if (/^file:/i.test(source)) return true;
    return /^(\.\/|\/)[^\0]+/.test(source);
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      if (!safeImageSource(source)) {
        reject(new TypeError("unsupported image source"));
        return;
      }
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        try {
          State.validateImageDimensions({
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
          });
          resolve(image);
        } catch (error) {
          image.onload = null;
          image.onerror = null;
          image.src = "";
          reject(error);
        }
      };
      image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        image.src = "";
        reject(new Error("image load failed"));
      };
      image.src = source;
    });
  }

  // 海报模板在绘制时把曲目封面派生为铺底背景。派生只发生在渲染/导出调用点，
  // 绝不写回 history state，否则 serializeState 会把封面底图粘进项目文件。
  function effectiveMediaState(state) {
    if (!state || state.template !== "poster") return state;
    if (state.media.background && state.media.background.src) return state;
    if (state.media.useTrackArtworkAsBackground) return state;
    return { ...state, media: { ...state.media, useTrackArtworkAsBackground: true } };
  }

  class ImageCache {
    constructor() {
      this.cache = new Map();
      this.lumaCache = new Map();
    }

    get(source) {
      if (!source) return Promise.resolve(null);
      if (!this.cache.has(source)) {
        this.cache.set(source, loadImage(source).catch(() => null));
      }
      return this.cache.get(source);
    }

    release(source) {
      const pending = this.cache.get(source);
      this.cache.delete(source);
      this.lumaCache.delete(source);
      if (!pending) return;
      pending.then((image) => {
        if (!image) return;
        image.onload = null;
        image.onerror = null;
        image.src = "";
      });
    }

    clear() {
      Array.from(this.cache.keys()).forEach((source) => this.release(source));
    }

    // 封面平均亮度（Rec.709 加权），经 16×16 scratch canvas 降采样，按 src 记忆化。
    // 海报模板用它自适应遮罩强度；采样失败（如画布被污染）回退 undefined，
    // 渲染层照旧使用固定遮罩。
    coverLuma(source, image) {
      if (!source || !image) return undefined;
      if (this.lumaCache.has(source)) return this.lumaCache.get(source);
      let luma;
      try {
        const scratch = document.createElement("canvas");
        scratch.width = 16;
        scratch.height = 16;
        const ctx = scratch.getContext("2d");
        ctx.drawImage(image, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let total = 0;
        for (let index = 0; index < data.length; index += 4) {
          total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        }
        luma = total / (data.length / 4) / 255;
      } catch (_error) {
        luma = undefined;
      }
      this.lumaCache.set(source, luma);
      return luma;
    }

    async resolve(state) {
      const backgroundSource = state.media.background && state.media.background.src
        ? state.media.background.src
        : state.media.useTrackArtworkAsBackground
          ? state.document.track.coverUrl
          : "";
      const coverSource = state.media.cover && state.media.cover.src
        ? state.media.cover.src
        : state.document.track.coverUrl;
      const wanted = new Set([backgroundSource, coverSource, ...state.stickers.map((sticker) => sticker.imageData)].filter(Boolean));
      Array.from(this.cache.keys()).forEach((source) => {
        if (!wanted.has(source)) this.release(source);
      });
      const [background, cover, stickerEntries] = await Promise.all([
        this.get(backgroundSource),
        this.get(coverSource),
        Promise.all(state.stickers.map(async (sticker) => [sticker.id, await this.get(sticker.imageData)])),
      ]);
      return {
        background,
        cover,
        coverLuma: this.coverLuma(coverSource, cover),
        stickers: new Map(stickerEntries.filter((entry) => entry[1])),
      };
    }
  }

  function readFileAsDataURL(file, maxBytes) {
    if (!file || !IMAGE_TYPES.has(file.type)) return Promise.reject(new TypeError("请选择 PNG、JPEG 或 WebP 图片"));
    if (file.size > maxBytes) return Promise.reject(new RangeError("图片大小超过限制"));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(State.validateImageDataURL(String(reader.result)));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file, maxBytes) {
    if (!file || file.size > maxBytes) return Promise.reject(new RangeError("项目文件大小超过限制"));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("读取项目失败"));
      reader.readAsText(file);
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("浏览器未生成 PNG"));
        }, "image/png");
      } catch (error) {
        reject(error);
      }
    });
  }

  function sanitizeFilename(value) {
    const normalized = String(value || "lyrics-card")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return normalized || "lyrics-card";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function glyphStickerDataUrl(glyph, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 192;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 192, 192);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 4;
    ctx.font = "700 136px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(glyph, 96, 102);
    ctx.fillText(glyph, 96, 102);
    return canvas.toDataURL("image/png");
  }

  function nativeBridge() {
    return root.webkit
      && root.webkit.messageHandlers
      && root.webkit.messageHandlers.shareEditor
      && typeof root.webkit.messageHandlers.shareEditor.postMessage === "function"
      ? root.webkit.messageHandlers.shareEditor
      : null;
  }

  function blobBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error("读取 PNG 失败"));
      reader.readAsDataURL(blob);
    });
  }

  function calculatePreviewSquareSize(stageWidth, stageHeight, horizontalInset, verticalInset, maximumSize) {
    const width = Number(stageWidth);
    const height = Number(stageHeight);
    const inlineInset = Number(horizontalInset);
    const blockInset = Number(verticalInset);
    const limit = maximumSize === undefined ? MAX_PREVIEW_CSS_SIZE : Number(maximumSize);
    if (![width, height, inlineInset, blockInset, limit].every(Number.isFinite) || limit <= 0) return 0;
    const availableWidth = Math.max(0, width - Math.max(0, inlineInset));
    const availableHeight = Math.max(0, height - Math.max(0, blockInset));
    return Math.max(0, Math.floor(Math.min(availableWidth, availableHeight, limit)));
  }

  function cssPixelValue(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  }

  class EditorController {
    constructor(documentInput) {
      this.elements = this.collectElements();
      this.imageCache = new ImageCache();
      this.history = State.createHistory(State.createEditorState(documentInput));
      this.resources = { background: null, cover: null, stickers: new Map() };
      this.renderGeneration = 0;
      this.gesture = null;
      // 行编辑展开是纯局部 UI 状态：不进 history，也不参与序列化。
      this.expandedLineIndex = null;
      this.repositoryPath = "lyrics";
      this.repositoryEntries = [];
      this.gateway = createDocumentGateway({
        fetchImpl: root.fetch ? root.fetch.bind(root) : null,
        applyDocument: (document) => this.loadDocument(document),
      });
      this.bindEvents();
      this.bindPreviewSizing();
      this.renderAll({ rebuildLyrics: true });
    }

    collectElements() {
      const ids = [
        "track-name", "undo-button", "redo-button", "mobile-project-button", "load-button", "project-menu-button", "project-input",
        "selection-limit", "lyrics-list", "track-summary", "status-output", "canvas-stage", "preview-canvas", "template-switch",
        "export-canvas", "download-button", "share-button", "background-color", "text-color", "tint-color",
        "caps-toggle", "background-input", "background-file-name", "remove-background", "cover-input",
        "cover-file-name", "remove-cover", "sticker-palette", "sticker-input", "sticker-summary", "delete-sticker",
        "source-dialog", "source-form", "close-source-dialog", "cancel-source-dialog", "repository-path",
        "repository-refresh", "repository-up", "repository-search", "repository-list", "repository-status",
      ];
      return Object.fromEntries(ids.map((id) => [id.replace(/-([a-z])/g, (_match, character) => character.toUpperCase()), document.getElementById(id)]));
    }

    bindPreviewSizing() {
      const update = () => this.syncPreviewCanvasSize();
      update();
      if (typeof root.ResizeObserver === "function") {
        this.previewResizeObserver = new root.ResizeObserver(update);
        this.previewResizeObserver.observe(this.elements.canvasStage);
      } else {
        root.addEventListener("resize", update);
      }
      if (typeof root.requestAnimationFrame === "function") root.requestAnimationFrame(update);
    }

    syncPreviewCanvasSize() {
      const stage = this.elements.canvasStage;
      const canvas = this.elements.previewCanvas;
      const computed = typeof root.getComputedStyle === "function" ? root.getComputedStyle(stage) : null;
      const horizontalInset = computed
        ? cssPixelValue(computed.paddingLeft) + cssPixelValue(computed.paddingRight)
        : 0;
      const verticalInset = computed
        ? cssPixelValue(computed.paddingTop) + cssPixelValue(computed.paddingBottom)
        : 0;
      const size = calculatePreviewSquareSize(
        stage.clientWidth,
        stage.clientHeight,
        horizontalInset,
        verticalInset,
      );
      if (size <= 0) return false;
      const sizeValue = `${size}px`;
      canvas.style.width = sizeValue;
      canvas.style.inlineSize = sizeValue;
      canvas.style.height = sizeValue;
      canvas.style.blockSize = sizeValue;
      return true;
    }

    bindEvents() {
      const e = this.elements;
      e.undoButton.addEventListener("click", () => this.undo());
      e.redoButton.addEventListener("click", () => this.redo());
      e.mobileProjectButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const actions = document.querySelector(".app-actions");
        const open = actions.classList.toggle("is-open");
        e.mobileProjectButton.setAttribute("aria-expanded", String(open));
      });
      document.addEventListener("click", () => {
        document.querySelector(".app-actions").classList.remove("is-open");
        e.mobileProjectButton.setAttribute("aria-expanded", "false");
      });
      e.loadButton.addEventListener("click", () => this.openSourceDialog());
      e.closeSourceDialog.addEventListener("click", () => e.sourceDialog.close());
      e.cancelSourceDialog.addEventListener("click", () => e.sourceDialog.close());
      e.sourceForm.addEventListener("submit", (event) => this.handleSourceSubmit(event));
      e.repositoryRefresh.addEventListener("click", () => this.loadRepositoryDirectory(this.repositoryPath));
      e.repositoryUp.addEventListener("click", () => this.loadRepositoryDirectory(this.parentRepositoryPath()));
      e.repositorySearch.addEventListener("input", () => this.renderRepositoryEntries());
      e.repositoryList.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-repository-path]");
        if (button) this.openRepositoryEntry(button.dataset.repositoryPath, button.dataset.repositoryType);
      });
      root.addEventListener("message", (event) => this.handleBootstrapMessage(event));
      e.projectMenuButton.addEventListener("click", () => this.saveProject());
      e.projectInput.addEventListener("change", (event) => this.openProject(event));
      e.downloadButton.addEventListener("click", () => this.exportImage("save"));
      e.shareButton.addEventListener("click", () => this.exportImage("share"));
      e.backgroundInput.addEventListener("change", (event) => this.setLocalMedia("background", event));
      e.coverInput.addEventListener("change", (event) => this.setLocalMedia("cover", event));
      e.removeBackground.addEventListener("click", () => this.execute({ type: "setMedia", kind: "background", value: null }));
      e.removeCover.addEventListener("click", () => this.execute({ type: "setMedia", kind: "cover", value: null }));
      e.stickerInput.addEventListener("change", (event) => this.addLocalSticker(event));
      e.deleteSticker.addEventListener("click", () => {
        const id = this.history.state.activeStickerId;
        if (id) this.execute({ type: "removeSticker", id });
      });

      e.backgroundColor.addEventListener("input", (event) => this.execute({ type: "setStyle", key: "backgroundColor", value: event.target.value }, false));
      e.textColor.addEventListener("input", (event) => this.execute({ type: "setStyle", key: "textColor", value: event.target.value }, false));
      e.tintColor.addEventListener("input", (event) => this.execute({ type: "setStyle", key: "backgroundTintedColor", value: event.target.value }, false));
      e.capsToggle.addEventListener("change", (event) => this.execute({ type: "setStyle", key: "capsMode", value: event.target.checked ? "allCaps" : "normal" }, false));

      document.querySelectorAll(".mobile-tool-dock button[data-mobile-tool]").forEach((button) => {
        button.addEventListener("click", () => this.activateMobileTool(button.dataset.mobileTool));
      });
      document.querySelectorAll("[data-control]").forEach((control) => {
        control.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-value]");
          if (!button) return;
          this.execute({ type: "setStyle", key: control.dataset.control, value: button.dataset.value }, false);
        });
      });
      e.templateSwitch.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-template]");
        if (!button) return;
        this.execute({ type: "setTemplate", template: button.dataset.template }, false);
      });
      document.getElementById("color-presets").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-background]");
        if (!button) return;
        this.execute({
          type: "setPalette",
          backgroundColor: button.dataset.background,
          textColor: button.dataset.text,
        }, false);
      });
      e.stickerPalette.querySelectorAll("button[data-glyph]").forEach((button) => {
        button.style.setProperty("--sticker-color", button.dataset.color);
        button.addEventListener("click", () => this.addGlyphSticker(button.dataset.glyph, button.dataset.color));
      });

      e.previewCanvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
      e.previewCanvas.addEventListener("pointermove", (event) => this.pointerMove(event));
      e.previewCanvas.addEventListener("pointerup", (event) => this.pointerUp(event));
      e.previewCanvas.addEventListener("pointercancel", (event) => this.pointerCancel(event));
      root.addEventListener("keydown", (event) => this.keyboardShortcut(event));
    }

    loadDocument(documentInput) {
      const document = State.normalizeDocument(documentInput);
      this.imageCache.clear();
      this.expandedLineIndex = null;
      this.history.reset(State.createEditorState(document));
      this.setStatus("歌词已载入");
      this.renderAll({ rebuildLyrics: true });
      return this.history.state;
    }

    restoreState(serialized) {
      const state = State.restoreState(serialized);
      this.imageCache.clear();
      this.expandedLineIndex = null;
      this.history.reset(state);
      this.setStatus("项目已恢复");
      this.renderAll({ rebuildLyrics: true });
      return state;
    }

    serializeState() {
      return State.serializeState(this.history.state);
    }

    execute(action, rebuildLyrics) {
      const before = this.history.state;
      const next = this.history.execute(action);
      if (next === before) {
        if (action.type === "toggleLine" && !before.selectedLineIndices.includes(action.index)) {
          this.setStatus(`最多选择 ${State.MAX_SELECTED_LINES} 行`, true);
        } else if (action.type === "addSticker" && before.stickers.length >= State.MAX_STICKERS) {
          this.setStatus(`最多添加 ${State.MAX_STICKERS} 个贴纸`, true);
        }
        return;
      }
      this.renderAll({ rebuildLyrics: rebuildLyrics !== false && (action.type === "toggleLine" || action.type === "removeSticker") });
    }

    undo() {
      this.history.undo();
      this.renderAll({ rebuildLyrics: true });
    }

    redo() {
      this.history.redo();
      this.renderAll({ rebuildLyrics: true });
    }

    keyboardShortcut(event) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target;
      if (target && target.closest && target.closest("dialog") && event.key.toLowerCase() !== "z") return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.redo();
      }
    }

    renderAll(options) {
      if (options && options.rebuildLyrics) this.renderLyricsList();
      this.syncControls();
      this.scheduleCanvasRender(this.history.state);
    }

    renderLyricsList() {
      const state = this.history.state;
      if (this.expandedLineIndex !== null && !state.selectedLineIndices.includes(this.expandedLineIndex)) {
        this.expandedLineIndex = null;
      }
      const fragment = document.createDocumentFragment();
      state.document.lyrics.lines.forEach((line) => {
        const selected = state.selectedLineIndices.includes(line.index);
        const expanded = selected && this.expandedLineIndex === line.index;
        const parts = State.splitTranslation(State.selectedLineText(state, line.index));
        const row = document.createElement("div");
        row.className = `lyric-row${selected ? " is-selected" : ""}${expanded ? " is-editing" : ""}`;

        const main = document.createElement("div");
        main.className = "lyric-row-main";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "line-toggle";
        toggle.setAttribute("aria-pressed", String(selected));
        toggle.setAttribute("aria-label", `选择第 ${line.index + 1} 行`);
        toggle.addEventListener("click", () => this.execute({ type: "toggleLine", index: line.index }, true));

        const check = document.createElement("span");
        check.className = "line-check";
        const checkIcon = document.createElement("span");
        checkIcon.className = "icon-slot";
        checkIcon.setAttribute("data-icon", "check");
        check.appendChild(checkIcon);

        const text = document.createElement("span");
        text.className = "line-text";
        const baseText = document.createElement("span");
        baseText.className = "line-text-base";
        baseText.textContent = parts.base || "(空行)";
        const translationText = document.createElement("span");
        translationText.className = "line-text-translation";
        translationText.textContent = parts.translation;
        text.append(baseText, translationText);
        toggle.append(check, text);
        main.appendChild(toggle);

        if (selected) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.className = "line-edit-toggle";
          edit.title = expanded ? "收起" : "编辑";
          edit.setAttribute("aria-expanded", String(expanded));
          edit.setAttribute("aria-label", expanded ? `收起第 ${line.index + 1} 行编辑` : `编辑第 ${line.index + 1} 行`);
          const editIcon = document.createElement("span");
          editIcon.className = "icon-slot";
          editIcon.setAttribute("data-icon", expanded ? "close" : "type");
          edit.appendChild(editIcon);
          edit.addEventListener("click", () => {
            this.expandedLineIndex = expanded ? null : line.index;
            this.renderLyricsList();
          });
          main.appendChild(edit);
        }
        row.appendChild(main);

        if (expanded) {
          const fields = document.createElement("div");
          fields.className = "line-editor-fields";
          const createField = (name, value) => {
            const field = document.createElement("label");
            field.className = `line-editor-field line-editor-field-${name === "原文" ? "base" : "translation"}`;
            const caption = document.createElement("span");
            caption.textContent = name;
            const editor = document.createElement("textarea");
            editor.className = "line-editor";
            editor.value = value;
            editor.rows = 2;
            editor.dir = state.document.lyrics.isRtlLanguage ? "rtl" : "auto";
            editor.setAttribute("aria-label", `编辑第 ${line.index + 1} 行${name}`);
            field.append(caption, editor);
            return { field, editor };
          };
          const base = createField("原文", parts.base);
          const translation = createField("译文", parts.translation);
          const commit = () => {
            baseText.textContent = base.editor.value || "(空行)";
            translationText.textContent = translation.editor.value.trim();
            this.execute({
              type: "setLineText",
              index: line.index,
              text: State.buildWords(base.editor.value, translation.editor.value),
            }, false);
          };
          base.editor.addEventListener("input", commit);
          translation.editor.addEventListener("input", commit);
          fields.append(base.field, translation.field);
          row.appendChild(fields);
        }
        fragment.appendChild(row);
      });
      this.elements.lyricsList.replaceChildren(fragment);
      if (Icons) Icons.hydrate(this.elements.lyricsList);
    }

    syncControls() {
      const state = this.history.state;
      const selected = state.selectedLineIndices.length;
      this.elements.selectionLimit.textContent = `${selected} / ${State.MAX_SELECTED_LINES}`;
      this.elements.selectionLimit.classList.toggle("is-full", selected >= State.MAX_SELECTED_LINES);
      const trackLabel = `${state.document.track.title} · ${state.document.track.artist}`;
      this.elements.trackName.textContent = trackLabel;
      this.elements.trackSummary.textContent = trackLabel;
      this.elements.undoButton.disabled = !this.history.canUndo;
      this.elements.redoButton.disabled = !this.history.canRedo;
      this.elements.backgroundColor.value = state.style.backgroundColor.slice(0, 7);
      this.elements.textColor.value = state.style.textColor.slice(0, 7);
      this.elements.tintColor.value = state.style.backgroundTintedColor.slice(0, 7);
      this.elements.capsToggle.checked = state.style.capsMode === "allCaps";
      this.elements.removeBackground.disabled = !state.media.background && !state.media.useTrackArtworkAsBackground;
      this.elements.removeCover.disabled = !state.media.cover;
      this.elements.backgroundFileName.textContent = state.media.background
        ? state.media.background.name
        : state.media.useTrackArtworkAsBackground ? "当前专辑封面" : "选择本地图片";
      this.elements.coverFileName.textContent = state.media.cover
        ? state.media.cover.name
        : state.document.track.coverUrl ? "当前专辑封面" : "选择本地封面";
      this.elements.deleteSticker.disabled = !state.activeStickerId;
      this.elements.stickerSummary.textContent = state.activeStickerId
        ? `${state.stickers.findIndex((item) => item.id === state.activeStickerId) + 1} / ${state.stickers.length}`
        : state.stickers.length ? `${state.stickers.length} 个贴纸` : "未选择贴纸";
      document.querySelectorAll("[data-control]").forEach((control) => {
        control.querySelectorAll("button[data-value]").forEach((button) => {
          button.classList.toggle("is-selected", state.style[control.dataset.control] === button.dataset.value);
        });
      });
      this.elements.templateSwitch.querySelectorAll("button[data-template]").forEach((button) => {
        const active = state.template === button.dataset.template;
        button.classList.toggle("is-selected", active);
        button.setAttribute("aria-pressed", String(active));
      });
      document.querySelectorAll(".color-swatch").forEach((button) => {
        button.classList.toggle("is-selected", state.style.backgroundColor === button.dataset.background);
      });
    }

    async scheduleCanvasRender(state) {
      const generation = ++this.renderGeneration;
      const effective = effectiveMediaState(state);
      const resources = await this.imageCache.resolve(effective);
      if (generation !== this.renderGeneration) return;
      this.resources = resources;
      Renderer.renderToCanvas(this.elements.previewCanvas, effective, resources, { showSelection: true });
    }

    activateMobileTool(name) {
      if (!["lyrics", "type", "layout", "media", "stickers", "export"].includes(name)) return;
      const editor = document.querySelector(".editor-grid");
      editor.dataset.mobileTool = name;
      document.querySelectorAll(".mobile-tool-dock button[data-mobile-tool]").forEach((button) => {
        const active = button.dataset.mobileTool === name;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      });
      const inspector = document.querySelector(".inspector");
      if (inspector && name !== "lyrics" && name !== "export") inspector.scrollTop = 0;
    }

    setStatus(message, error) {
      this.elements.statusOutput.textContent = message || "";
      this.elements.statusOutput.classList.toggle("is-error", Boolean(error));
    }

    openSourceDialog() {
      this.applyBootstrapFields(RepositorySource && RepositorySource.readBootstrap(root.location && root.location.search));
      this.elements.sourceDialog.showModal();
      const token = this.sourceToken();
      if (token) this.loadRepositoryDirectory(this.repositoryPath);
    }

    applyBootstrapFields(bootstrap) {
      const track = bootstrap && bootstrap.track;
      if (!track) return;
      for (const name of ["trackId", "title", "artist", "album"]) {
        const input = this.elements.sourceForm.elements.namedItem(name);
        if (input && !input.value) input.value = String(track[name] || "");
      }
    }

    sourceToken() {
      return String(this.elements.sourceForm.elements.namedItem("token")?.value || "").trim();
    }

    parentRepositoryPath() {
      const parts = this.repositoryPath.split("/");
      return parts.length > 1 ? parts.slice(0, -1).join("/") : "lyrics";
    }

    setRepositoryStatus(message, error) {
      this.elements.repositoryStatus.textContent = String(message || "");
      this.elements.repositoryStatus.classList.toggle("is-error", Boolean(error));
    }

    renderRepositoryEntries() {
      const entries = RepositorySource.filterEntries(this.repositoryEntries, this.elements.repositorySearch.value);
      this.elements.repositoryPath.textContent = `${this.repositoryPath} /`;
      this.elements.repositoryUp.disabled = this.repositoryPath === "lyrics";
      this.elements.repositoryList.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement("p");
        empty.className = "repository-empty";
        empty.textContent = this.repositoryEntries.length ? "没有匹配项" : "当前目录为空";
        this.elements.repositoryList.append(empty);
        return;
      }
      for (const entry of entries) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.repositoryPath = entry.path;
        button.dataset.repositoryType = entry.type;
        button.setAttribute("role", "option");
        const icon = document.createElement("span");
        icon.className = "repository-entry-icon icon-slot";
        icon.setAttribute("data-icon", entry.type === "dir" ? "folder" : "music");
        const label = document.createElement("span");
        label.className = "repository-entry-label";
        label.textContent = entry.name;
        const meta = document.createElement("small");
        meta.textContent = entry.type === "dir" ? "目录" : entry.size ? `${entry.size} bytes` : "歌词文件";
        button.append(icon, label, meta);
        this.elements.repositoryList.append(button);
      }
      if (Icons) Icons.hydrate(this.elements.repositoryList);
    }

    async loadRepositoryDirectory(path) {
      if (!RepositorySource) return;
      const token = this.sourceToken();
      if (!token) {
        this.setRepositoryStatus("请先填写访问令牌", true);
        return;
      }
      this.elements.repositoryRefresh.disabled = true;
      this.setRepositoryStatus("正在读取目录…");
      try {
        const client = RepositorySource.createClient(root.fetch.bind(root), token);
        const result = await client.list(path || "lyrics");
        this.repositoryPath = result.path;
        this.repositoryEntries = result.entries;
        this.elements.repositorySearch.value = "";
        this.renderRepositoryEntries();
        this.setRepositoryStatus(`${result.entries.length} 项`);
      } catch (error) {
        this.setRepositoryStatus(error.message || "仓库目录读取失败", true);
      } finally {
        this.elements.repositoryRefresh.disabled = false;
      }
    }

    async openRepositoryEntry(path, type) {
      if (type === "dir") {
        await this.loadRepositoryDirectory(path);
        return;
      }
      const token = this.sourceToken();
      if (!token) {
        this.setRepositoryStatus("请先填写访问令牌", true);
        return;
      }
      this.setRepositoryStatus("正在载入歌词…");
      try {
        const client = RepositorySource.createClient(root.fetch.bind(root), token);
        const document = await client.read(path);
        await this.gateway.loadDocument(document);
        this.elements.sourceForm.elements.namedItem("token").value = "";
        this.elements.sourceDialog.close();
        this.setStatus(`已从 Lyrics Repo 载入 ${path}`);
      } catch (error) {
        this.setRepositoryStatus(error.message || "仓库文件读取失败", true);
      }
    }

    async loadBootstrap(bootstrap) {
      const track = bootstrap && bootstrap.track;
      if (!track || !String(track.trackId || "").trim()) return false;
      const token = String(bootstrap.token || "").trim();
      this.applyBootstrapFields({ track });
      if (!token) {
        this.openSourceDialog();
        this.setRepositoryStatus("当前曲目已填入；请填写令牌后载入", false);
        return false;
      }
      this.setStatus("正在载入当前曲目…");
      try {
        const payload = await this.gateway.fetchFromServer({ track }, token);
        const coverDataURL = String(bootstrap.coverDataURL || "");
        if (coverDataURL) {
          State.validateImageDataURL(coverDataURL);
          payload.track = { ...(payload.track || track), coverUrl: coverDataURL };
        }
        this.loadDocument(payload);
        this.setStatus("当前曲目已载入");
        return true;
      } catch (error) {
        this.setStatus(error.message || "当前曲目载入失败", true);
        return false;
      }
    }

    handleBootstrapMessage(event) {
      const payload = event && event.data;
      if (!payload || event.source !== root.parent || payload.type !== "mitm-lyrics-editor-bootstrap" || payload.mode !== "share") return;
      this.loadBootstrap(payload);
    }

    async handleSourceSubmit(event) {
      event.preventDefault();
      const data = new FormData(this.elements.sourceForm);
      const submit = this.elements.sourceForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      this.setStatus("正在载入…");
      try {
        const token = String(data.get("token") || "");
        const tokenInput = this.elements.sourceForm.elements.namedItem("token");
        if (tokenInput) tokenInput.value = "";
        await this.gateway.loadFromServer({
          track: {
            trackId: String(data.get("trackId") || ""),
            title: String(data.get("title") || ""),
            artist: String(data.get("artist") || ""),
            album: String(data.get("album") || ""),
          },
        }, token);
        this.elements.sourceDialog.close();
      } catch (error) {
        this.setStatus(error.message || "歌词载入失败", true);
      } finally {
        submit.disabled = false;
      }
    }

    async setLocalMedia(kind, event) {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      try {
        const src = await readFileAsDataURL(file, MAX_IMAGE_BYTES);
        this.execute({ type: "setMedia", kind, value: { src, name: file.name, type: file.type } }, false);
        this.setStatus(kind === "cover" ? "封面已替换" : "背景已替换");
      } catch (error) {
        this.setStatus(error.message || "图片读取失败", true);
      }
    }

    addGlyphSticker(glyph, color) {
      const id = `sticker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        const before = this.history.state;
        this.execute({
          type: "addSticker",
          sticker: {
            id,
            stickerID: `glyph-${glyph.codePointAt(0).toString(16)}`,
            imageData: glyphStickerDataUrl(glyph, color),
            normalizedCenter: { x: 0.72, y: 0.7 },
            normalizedSize: { width: 0.2, height: 0.2 },
            rotation: 0,
          },
        }, false);
        if (this.history.state !== before) this.setStatus("贴纸已添加");
      } catch (error) {
        this.setStatus(error.message || "贴纸添加失败", true);
      }
    }

    async addLocalSticker(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      try {
        const imageData = await readFileAsDataURL(file, MAX_IMAGE_BYTES);
        const id = `sticker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.execute({
          type: "addSticker",
          sticker: {
            id,
            stickerID: file.name,
            imageData,
            normalizedCenter: { x: 0.7, y: 0.7 },
            normalizedSize: { width: 0.25, height: 0.25 },
            rotation: 0,
          },
        }, false);
        this.setStatus("贴纸已添加");
      } catch (error) {
        this.setStatus(error.message || "贴纸读取失败", true);
      }
    }

    canvasPoint(event) {
      const rect = this.elements.previewCanvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / rect.width * Renderer.LAYOUT.logicalSize,
        y: (event.clientY - rect.top) / rect.height * Renderer.LAYOUT.logicalSize,
      };
    }

    pointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return;
      const point = this.canvasPoint(event);
      const state = this.history.state;
      const active = state.stickers.find((item) => item.id === state.activeStickerId);
      const handle = active && Renderer.stickerHandlePoint(active);
      let sticker = null;
      let mode = "drag";
      if (active && Math.hypot(point.x - handle.x, point.y - handle.y) <= 11) {
        sticker = active;
        mode = "transform";
      } else {
        sticker = state.stickers.slice().reverse().find((item) => Renderer.pointInSticker(item, point)) || null;
      }
      if (!sticker) {
        this.history.setTransient(State.reduceEditorState(state, { type: "selectSticker", id: null }));
        this.renderAll({ rebuildLyrics: false });
        return;
      }
      const selectedState = State.reduceEditorState(state, { type: "selectSticker", id: sticker.id });
      this.history.setTransient(selectedState);
      const center = Renderer.stickerGeometry(sticker);
      this.gesture = {
        pointerId: event.pointerId,
        mode,
        startPoint: point,
        startSticker: sticker,
        startDistance: Math.max(1, Math.hypot(point.x - center.centerX, point.y - center.centerY)),
        startAngle: Math.atan2(point.y - center.centerY, point.x - center.centerX),
      };
      this.elements.previewCanvas.setPointerCapture(event.pointerId);
      this.elements.previewCanvas.classList.add("is-manipulating");
      this.syncControls();
      this.scheduleCanvasRender(selectedState);
    }

    transformedSticker(event) {
      if (!this.gesture) return null;
      const point = this.canvasPoint(event);
      const start = this.gesture.startSticker;
      if (this.gesture.mode === "drag") {
        const dx = (point.x - this.gesture.startPoint.x) / Renderer.LAYOUT.logicalSize;
        const dy = (point.y - this.gesture.startPoint.y) / Renderer.LAYOUT.logicalSize;
        return {
          ...start,
          normalizedCenter: {
            x: Math.min(1, Math.max(0, start.normalizedCenter.x + dx)),
            y: Math.min(1, Math.max(0, start.normalizedCenter.y + dy)),
          },
        };
      }
      const geometry = Renderer.stickerGeometry(start);
      const distance = Math.max(1, Math.hypot(point.x - geometry.centerX, point.y - geometry.centerY));
      const ratio = Math.min(4, Math.max(0.25, distance / this.gesture.startDistance));
      const angle = Math.atan2(point.y - geometry.centerY, point.x - geometry.centerX);
      return {
        ...start,
        normalizedSize: {
          width: Math.min(0.8, Math.max(0.06, start.normalizedSize.width * ratio)),
          height: Math.min(0.8, Math.max(0.06, start.normalizedSize.height * ratio)),
        },
        rotation: start.rotation + angle - this.gesture.startAngle,
      };
    }

    pointerMove(event) {
      if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
      const sticker = this.transformedSticker(event);
      const draft = State.reduceEditorState(this.history.state, { type: "replaceSticker", sticker });
      Renderer.renderToCanvas(this.elements.previewCanvas, effectiveMediaState(draft), this.resources, { showSelection: true });
    }

    pointerUp(event) {
      if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
      const sticker = this.transformedSticker(event);
      this.gesture = null;
      this.elements.previewCanvas.classList.remove("is-manipulating");
      this.execute({ type: "replaceSticker", sticker }, false);
    }

    pointerCancel(event) {
      if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
      this.gesture = null;
      this.elements.previewCanvas.classList.remove("is-manipulating");
      this.scheduleCanvasRender(this.history.state);
    }

    saveProject() {
      try {
        const payload = this.serializeState();
        const filename = `${sanitizeFilename(this.history.state.document.track.title)}.lyrics-card.json`;
        downloadBlob(new Blob([payload], { type: "application/json" }), filename);
        this.setStatus("项目已保存");
      } catch (error) {
        this.setStatus(error.message || "项目保存失败", true);
      }
    }

    async openProject(event) {
      const input = event.target;
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      try {
        const payload = await readFileAsText(file, MAX_PROJECT_BYTES);
        this.restoreState(payload);
      } catch (error) {
        this.setStatus(error.message || "项目打开失败", true);
      }
    }

    async renderExport() {
      const state = effectiveMediaState(this.history.state);
      let resources = await this.imageCache.resolve(state);
      Renderer.renderToCanvas(this.elements.exportCanvas, state, resources, { showSelection: false });
      try {
        this.elements.exportCanvas.getContext("2d").getImageData(0, 0, 1, 1);
      } catch (_error) {
        resources = {
          ...resources,
          cover: state.media.cover ? resources.cover : null,
        };
        this.elements.exportCanvas.width = 1;
        this.elements.exportCanvas.height = 1;
        Renderer.renderToCanvas(this.elements.exportCanvas, state, resources, { showSelection: false });
      }
      return canvasToBlob(this.elements.exportCanvas);
    }

    async exportImage(action) {
      this.elements.downloadButton.disabled = true;
      this.elements.shareButton.disabled = true;
      this.setStatus("正在生成 PNG…");
      try {
        const blob = await this.renderExport();
        const filename = `${sanitizeFilename(this.history.state.document.track.title)}.png`;
        const bridge = nativeBridge();
        if (bridge) {
          bridge.postMessage({
            command: "exportPng",
            action,
            base64: await blobBase64(blob),
            suggestedFilename: filename,
          });
          this.setStatus(action === "share" ? "已交给系统分享" : "已交给本地保存");
          return;
        }

        downloadBlob(blob, filename);
        this.setStatus("PNG 已保存");
      } catch (error) {
        if (error && error.name === "AbortError") this.setStatus("");
        else this.setStatus(error.message || "PNG 导出失败", true);
      } finally {
        this.elements.downloadButton.disabled = false;
        this.elements.shareButton.disabled = false;
      }
    }
  }

  const publicApi = {
    loadDocument(document) {
      if (mountedController) return Promise.resolve(mountedController.loadDocument(document));
      pendingDocument = State.normalizeDocument(document);
      pendingState = null;
      return Promise.resolve(pendingDocument);
    },
    restoreState(serialized) {
      if (mountedController) return mountedController.restoreState(serialized);
      pendingState = State.restoreState(serialized);
      pendingDocument = null;
      return pendingState;
    },
    serializeState() {
      if (mountedController) return mountedController.serializeState();
      if (pendingState) return State.serializeState(pendingState);
      throw new Error("editor is not mounted");
    },
    loadFromServer(query, token) {
      if (!mountedController) throw new Error("editor is not mounted");
      return mountedController.gateway.loadFromServer(query, token);
    },
    getState() {
      return mountedController ? mountedController.history.state : pendingState;
    },
  };

  function mount() {
    if (mountedController || !root.document || !root.document.getElementById("share-editor-app")) return mountedController;
    if (Icons && typeof Icons.hydrate === "function") Icons.hydrate(root.document);
    // 浏览器侧没有系统分享：无原生桥时隐藏 share 按钮，只留「保存 PNG」。
    const shareButton = root.document.getElementById("share-button");
    if (shareButton) shareButton.hidden = !nativeBridge();
    const initial = pendingState || pendingDocument || DEMO_DOCUMENT;
    mountedController = new EditorController(initial.document ? initial.document : initial);
    if (pendingState) mountedController.history.reset(pendingState);
    mountedController.renderAll({ rebuildLyrics: true });
    pendingDocument = null;
    pendingState = null;
    const bootstrap = RepositorySource && RepositorySource.readBootstrap(root.location && root.location.search);
    if (bootstrap && bootstrap.track && bootstrap.track.trackId) {
      mountedController.applyBootstrapFields(bootstrap);
    }
    if (root.parent && root.parent !== root) {
      try { root.parent.postMessage({ type: "mitm-lyrics-editor-ready", mode: "share" }, "*"); } catch (_) {}
    }
    return mountedController;
  }

  return Object.freeze({
    ENDPOINT,
    DEMO_DOCUMENT,
    createDocumentGateway,
    calculatePreviewSquareSize,
    effectiveMediaState,
    safeImageSource,
    sanitizeFilename,
    publicApi,
    mount,
  });
});
