(function (root, State) {
  "use strict";
  if (!root || !State) return;

  const $ = (selector) => document.querySelector(selector);
  let editorState = null;
  let history = [];
  let future = [];
  let previewTimer = null;
  let draftTimer = null;
  let browserHost = null;
  let browserParentOrigin = "";
  let browserParent = null;
  let lrcImportResult = null;
  let lrcImportRevision = 0;
  let lrcActionInFlight = false;
  let nativeRequestSequence = 0;
  const nativeRequests = new Map();
  let retranslationRevision = 0;
  let retranslationModels = [];
  let retranslationSelectedModel = "";
  let retranslationCandidate = null;
  let retranslationSourceSnapshot = "";
  let retranslationInFlight = "";
  let retranslationError = "";
  let segmentSession = null;
  let segmentRequestRevision = 0;
  let segmentLoading = false;
  let segmentSaving = false;
  let segmentError = "";
  let pointerControl = null;
  const inputIds = ["current-base", "current-translation", "current-start", "current-end", "current-syllables"];

  function bridge(message) {
    const nativeBridge = root.webkit?.messageHandlers?.timelineEditor;
    if (nativeBridge && typeof nativeBridge.postMessage === "function") {
      try { nativeBridge.postMessage(message); } catch (_) {}
      return;
    }
    if (browserHost) browserHost.command(message).catch((error) => {
      if (message.command !== "save") status(error.message || "播放器命令失败", true);
    });
  }

  function commandError(payload, fallback) {
    const source = payload && typeof payload === "object" ? payload : {};
    const reason = String(source.reason || source.error || fallback || "请求失败");
    const details = [];
    if (source.detail) details.push(String(source.detail));
    if (Array.isArray(source.missingFields) && source.missingFields.length) {
      details.push(`missing fields: ${source.missingFields.map(String).filter(Boolean).join(", ")}`);
    }
    if (Number(source.upstreamStatus) > 0) details.push(`upstream HTTP ${Number(source.upstreamStatus)}`);
    const error = new Error(details.length ? `${reason}: ${details.join("; ")}` : reason);
    error.payload = source;
    error.status = Number(source.status || 0);
    return error;
  }

  function hostCommand(message) {
    if (browserHost) return browserHost.command(message);
    const nativeBridge = root.webkit?.messageHandlers?.timelineEditor;
    if (!nativeBridge || typeof nativeBridge.postMessage !== "function") {
      return Promise.reject(new Error("当前宿主不支持歌词服务命令"));
    }
    const requestId = `timeline-${Date.now()}-${++nativeRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        nativeRequests.delete(requestId);
        reject(new Error("歌词服务请求超时"));
      }, 200000);
      nativeRequests.set(requestId, { resolve, reject, timeout });
      try {
        nativeBridge.postMessage({ ...message, requestId });
      } catch (error) {
        clearTimeout(timeout);
        nativeRequests.delete(requestId);
        reject(error);
      }
    });
  }

  function status(message, error) {
    const output = $("#status");
    if (!output) return;
    output.textContent = String(message || "");
    output.classList.toggle("is-error", Boolean(error));
  }

  function formatMs(value) {
    const ms = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor(ms % 1000);
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function lines() { return editorState ? State.lines(editorState) : []; }
  function currentLine() { return lines()[editorState?.selectedIndex || 0] || null; }
  function currentViewLine() { return editorState ? State.viewLine(editorState, editorState.selectedIndex) : null; }
  function pushHistory() {
    if (!editorState) return;
    try { history.push(State.serializeState(editorState)); if (history.length > 40) history.shift(); future = []; } catch (_) {}
  }
  function mutate(callback) { pushHistory(); callback(); render(); scheduleDraft(); }

  function updateSliderFill(slider) {
    const max = Number(slider.max) || 0;
    const ratio = max > 0 ? Math.min(1, Math.max(0, Number(slider.value) / max)) : 0;
    slider.style.setProperty("--slider-fill", `${ratio * 100}%`);
  }

  function setCuePill(id, on, label) {
    const pill = $(`#${id}`);
    if (!pill) return;
    pill.classList.toggle("is-on", on);
    pill.setAttribute("aria-pressed", String(on));
    const text = $(`#${id} .pill-text`);
    if (text) text.textContent = label;
  }

  function renderTransport() {
    const player = editorState?.player || { positionMs: 0, durationMs: 0, isPlaying: false };
    const sameTrack = Boolean(editorState && player.trackId === editorState.document.track.trackId);
    $("#position-label").textContent = formatMs(player.positionMs);
    $("#duration-label").textContent = formatMs(player.durationMs);
    const slider = $("#position-slider");
    slider.max = String(Math.max(0, Number(player.durationMs) || 0));
    slider.value = String(Math.min(Number(slider.max), Math.max(0, Number(player.positionMs) || 0)));
    updateSliderFill(slider);
    $("#play-button").classList.toggle("is-playing", player.isPlaying === true);
    $("#play-button").disabled = !sameTrack || (player.isPlaying ? player.canPause !== true : player.canPlay !== true);
    $("#position-slider").disabled = !sameTrack || player.canSeek !== true;
    $("#play-line").disabled = !sameTrack || player.canSeek !== true || player.canPlay !== true;
    $("#cue-start").disabled = !sameTrack;
    $("#cue-end").disabled = !sameTrack;
    setCuePill("cue-toggle", editorState?.cueEnabled === true, "打点");
    const wordMode = editorState?.cueWordMode === true;
    const tokens = State.cueTokens(currentViewLine()?.base || "");
    const completed = State.normalizeSyllables(currentLine()?.syllables).length;
    setCuePill("cue-word-toggle", wordMode, wordMode ? `逐词 ${Math.min(completed, tokens.length)}/${tokens.length}` : "逐词");
    $("#cue-shortcuts").dataset.enabled = String(editorState?.cueEnabled === true);
    $("#cue-shortcut-w-label").textContent = wordMode ? "下一个词" : "start + 下一行";
    $("#cue-shortcut-e-label").textContent = wordMode ? "完成本行" : "end + 下一行";
    $("#cue-start").textContent = wordMode ? "打下一个词" : "写入 start";
    $("#cue-end").textContent = wordMode ? "完成本行" : "写入 end";
    $("#dock-cue-primary").textContent = wordMode ? "打下一个词" : "写入 start";
    $("#dock-cue-end").textContent = wordMode ? "完成本行" : "写入 end";
    $("#dock-cue-primary").disabled = !sameTrack;
    $("#dock-cue-end").disabled = !sameTrack;
  }

  function renderCurrent() {
    const line = currentLine();
    const index = editorState ? editorState.selectedIndex : 0;
    const view = editorState ? State.viewLine(editorState, index) : null;
    $("#current-index").textContent = `第 ${index + 1} 行`;
    for (const id of inputIds) {
      const element = $(`#${id}`);
      if (!element) continue;
      const value = id === "current-base" ? view?.base || ""
        : id === "current-translation" ? view?.translation || ""
        : id === "current-syllables" ? State.normalizeSyllables(line?.syllables).filter((x) => x.timeMs || x.text).map((x) => `${x.timeMs}:${x.text}`).join("\n")
        : id === "current-start" ? line?.startTimeMs || ""
        : id === "current-end" ? line?.endTimeMs || ""
        : "";
      if (document.activeElement !== element) element.value = value;
    }
  }

  function renderRows() {
    const list = $("#lines-list");
    list.replaceChildren();
    const all = lines();
    $("#line-count").textContent = `${all.length} 行`;
    all.forEach((line, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `line-row${index === editorState.selectedIndex ? " is-current" : ""}`;
      row.dataset.index = String(index);
      const number = document.createElement("span"); number.className = "line-number"; number.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("span"); copy.className = "line-copy";
      const view = State.viewLine(editorState, index);
      const base = document.createElement("strong"); base.textContent = view.base || "（空行）";
      const translation = document.createElement("small"); translation.textContent = view.translation;
      copy.append(base, translation);
      const times = document.createElement("span"); times.className = "line-times"; times.textContent = `${line.startTimeMs || "—"}\n${line.endTimeMs || "—"}`;
      row.append(number, copy, times);
      row.addEventListener("click", () => { editorState.selectedIndex = index; render(); scheduleDraft(); activateMobileView("current"); });
      list.append(row);
    });
    const selected = list.querySelector(".is-current");
    if (selected && editorState?.player?.isPlaying) selected.scrollIntoView({ block: "nearest" });
  }

  function render() {
    if (!editorState) return;
    const track = editorState.document.track;
    $("#track-subtitle").textContent = `${track.artist} · ${track.title}`;
    renderTransport(); renderCurrent(); renderRows();
    const mode = editorState.document.lyrics.lyrics.syncType || "";
    document.querySelectorAll("[data-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode || "") === mode ? "true" : "false"));
  }

  function updateCurrent(patch) { if (!editorState) return; mutate(() => State.applyLine(editorState, editorState.selectedIndex, patch)); }

  function currentPosition() { return Math.max(0, Math.round(Number(editorState?.player?.positionMs) || 0)); }
  function activateMobileView(name) {
    if (name !== "current" && name !== "lines") return;
    const workspace = $(".workspace");
    const tabs = $(".mobile-workspace-tabs");
    if (!workspace) return;
    workspace.dataset.mobileView = name;
    document.querySelectorAll(".mobile-workspace-tabs [data-mobile-view]").forEach((button) => {
      const active = button.dataset.mobileView === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    if (tabs && root.matchMedia?.("(max-width: 680px)").matches) {
      tabs.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }
  function setCueSyncType(syncType) {
    if (!editorState) return;
    State.setSyncType(editorState, syncType);
  }

  function cueStart() {
    setCueSyncType(editorState?.cueWordMode ? "SYLLABLE_SYNCED" : "LINE_SYNCED");
    updateCurrent({ startTimeMs: String(currentPosition()) });
    moveNext();
  }

  function cueEnd() {
    setCueSyncType(editorState?.cueWordMode ? "SYLLABLE_SYNCED" : "LINE_SYNCED");
    updateCurrent({ endTimeMs: String(currentPosition()) });
    moveNext();
  }
  function cueNextWord() {
    setCueSyncType("SYLLABLE_SYNCED");
    const line = currentLine();
    const tokens = State.cueTokens(currentViewLine()?.base || "");
    if (!tokens.length) { status("当前行没有可打点的词", true); return; }
    const items = State.normalizeSyllables(line?.syllables);
    if (items.length >= tokens.length) { cueEnd(); return; }
    const positionMs = String(currentPosition());
    const patch = {
      syllables: [...items, { index: items.length, timeMs: positionMs, text: tokens[items.length] }],
    };
    if (!String(line?.startTimeMs || "").trim()) patch.startTimeMs = items[0]?.timeMs || positionMs;
    updateCurrent(patch);
  }
  function cuePrimary() { if (editorState?.cueWordMode) cueNextWord(); else cueStart(); }
  function moveSelection(delta) { if (!editorState) return; State.moveSelection(editorState, delta); render(); scheduleDraft(); }
  function moveNext() { moveSelection(1); }
  function movePrevious() { moveSelection(-1); }
  function addBefore() { if (editorState) mutate(() => State.addLine(editorState, editorState.selectedIndex)); }
  function addAfter() { if (editorState) mutate(() => State.addLine(editorState, editorState.selectedIndex + 1)); }
  function removeCurrent() { if (editorState) mutate(() => State.removeLine(editorState, editorState.selectedIndex)); }

  function renderLRCImport() {
    const summary = $("#lrc-import-summary");
    const metadata = $("#lrc-import-metadata");
    const errors = $("#lrc-import-errors");
    const confirm = $("#lrc-import-confirm");
    const translate = $("#lrc-import-translate");
    errors.replaceChildren();
    if (!lrcImportResult) {
      summary.textContent = "等待粘贴";
      metadata.hidden = true;
      errors.hidden = true;
      confirm.disabled = true;
      translate.disabled = true;
      return;
    }

    const wordLines = lrcImportResult.lines.filter((line) => line.words.trim()).length;
    const emptyLines = lrcImportResult.lines.length - wordLines;
    summary.textContent = `${lrcImportResult.lines.length} 行 · ${wordLines} 有词 · ${emptyLines} 空行`;
    const metadataParts = [
      lrcImportResult.metadata.title,
      lrcImportResult.metadata.artist,
      lrcImportResult.metadata.album,
    ].filter(Boolean);
    metadata.textContent = metadataParts.join(" · ");
    metadata.hidden = !metadataParts.length;
    lrcImportResult.errors.forEach((error) => {
      const item = document.createElement("li");
      item.textContent = error.lineNumber ? `第 ${error.lineNumber} 行：${error.reason}` : error.reason;
      errors.append(item);
    });
    errors.hidden = !lrcImportResult.errors.length;
    const invalid = Boolean(lrcImportResult.errors.length || !lrcImportResult.lines.length);
    confirm.disabled = lrcActionInFlight || invalid;
    translate.disabled = lrcActionInFlight || invalid;
  }

  function setLRCActionLoading(action) {
    lrcActionInFlight = Boolean(action);
    const confirm = $("#lrc-import-confirm");
    const translate = $("#lrc-import-translate");
    confirm.textContent = action === "replace" ? "正在校验…" : "替换歌词";
    confirm.setAttribute("aria-busy", String(action === "replace"));
    translate.textContent = action === "translate" ? "正在提交翻译…" : "提交翻译并替换歌词";
    translate.setAttribute("aria-busy", String(action === "translate"));
    renderLRCImport();
  }

  function canonicalActionHostAvailable() {
    if (browserHost || root.webkit?.messageHandlers?.timelineEditor) return true;
    status("当前宿主尚未实现 canonical 校验，无法安全执行 LRC 替换", true);
    return false;
  }

  function trackIdentity(track) {
    return JSON.stringify([
      String(track?.trackId || ""),
      String(track?.artist || ""),
      String(track?.title || ""),
      String(track?.album || ""),
    ]);
  }

  function openLRCImport() {
    if (!editorState) return;
    const dialog = $("#lrc-import-dialog");
    const input = $("#lrc-import-input");
    input.value = "";
    lrcImportRevision += 1;
    lrcImportResult = null;
    renderLRCImport();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    input.focus();
  }

  async function confirmLRCImport() {
    const dialog = $("#lrc-import-dialog");
    if (lrcActionInFlight || !editorState || !lrcImportResult
      || lrcImportResult.errors.length || !lrcImportResult.lines.length) return;
    if (!canonicalActionHostAvailable()) return;
    const requestRevision = lrcImportRevision;
    const originalHash = editorState.document.hash;
    const originalTrackIdentity = trackIdentity(editorState.document.track);
    setLRCActionLoading("replace");
    try {
      await hostCommand({
        command: "validateCanonical",
        payload: { track: { ...editorState.document.track } },
      });
      const dialogOpen = dialog.open || dialog.hasAttribute("open");
      if (!dialogOpen || requestRevision !== lrcImportRevision || !editorState
        || editorState.document.hash !== originalHash
        || trackIdentity(editorState.document.track) !== originalTrackIdentity) return;
      mutate(() => State.replaceLinesFromLRC(editorState, lrcImportResult.lines));
    } catch (error) {
      const dialogOpen = dialog.open || dialog.hasAttribute("open");
      if (dialogOpen && requestRevision === lrcImportRevision) {
        status(`替换失败：${error.message || "unknown"}`, true);
      }
      return;
    } finally {
      setLRCActionLoading("");
    }
    dialog.close();
    status(`已导入 ${lines().length} 行歌词`);
    activateMobileView("current");
  }

  async function submitLRCTranslation() {
    const dialog = $("#lrc-import-dialog");
    if (lrcActionInFlight || !editorState || !lrcImportResult
      || lrcImportResult.errors.length || !lrcImportResult.lines.length) return;
    if (!canonicalActionHostAvailable()) return;
    const requestRevision = lrcImportRevision;
    const originalHash = editorState.document.hash;
    const originalTrackIdentity = trackIdentity(editorState.document.track);
    let candidate;
    try {
      candidate = State.createTranslationCandidate(editorState, lrcImportResult.lines);
    } catch (error) {
      status(error.message || "LRC 翻译提交失败", true);
      return;
    }

    setLRCActionLoading("translate");
    try {
      const response = await hostCommand({ command: "translate", payload: candidate });
      const validated = State.validateTranslationResponse(response);
      const dialogOpen = dialog.open || dialog.hasAttribute("open");
      if (!dialogOpen || requestRevision !== lrcImportRevision || !editorState
        || editorState.document.hash !== originalHash
        || trackIdentity(editorState.document.track) !== originalTrackIdentity) return;
      mutate(() => State.replaceLyricsFromTranslation(editorState, validated));
      dialog.close();
      status(`已翻译并导入 ${lines().length} 行歌词`);
      activateMobileView("current");
    } catch (error) {
      const dialogOpen = dialog.open || dialog.hasAttribute("open");
      if (dialogOpen && requestRevision === lrcImportRevision) {
        status(`翻译失败：${error.message || "unknown"}`, true);
      }
    } finally {
      setLRCActionLoading("");
    }
  }

  function previewCurrent() {
    const line = currentLine();
    const start = Number(line?.startTimeMs);
    if (!Number.isFinite(start)) { status("当前行没有有效 start", true); return; }
    if (editorState.player.trackId !== editorState.document.track.trackId || editorState.player.canSeek !== true || editorState.player.canPlay !== true) {
      status("当前播放器不支持该曲目的预览播放", true); return;
    }
    bridge({ command: "seek", positionMs: Math.max(0, Math.round(start)) });
    bridge({ command: "play" });
    if (previewTimer) clearInterval(previewTimer);
    const end = Number(line.endTimeMs);
    if (Number.isFinite(end) && end > start) previewTimer = setInterval(() => { if ((editorState?.player?.positionMs || 0) >= end) { bridge({ command: "pause" }); clearInterval(previewTimer); previewTimer = null; } }, 60);
  }

  function setRetranslationError(message) {
    retranslationError = String(message || "");
    const output = $("#retranslate-status");
    if (!output) return;
    output.textContent = retranslationError;
    output.classList.toggle("is-error", Boolean(retranslationError));
  }

  function validateModelsResponse(payload) {
    if (!payload || payload.ok !== true || !Array.isArray(payload.models)) {
      throw new Error("模型服务返回了无效响应");
    }
    const seen = new Set();
    const models = payload.models.map((item) => ({
      id: String(item?.id || "").trim(),
      provider: String(item?.provider || "").trim(),
      supportsGenius: item?.supportsGenius === true,
    })).filter((item) => item.id && item.provider && !seen.has(item.id) && seen.add(item.id));
    if (!models.length) throw new Error("服务器没有配置可用的翻译模型");
    const requestedDefault = String(payload.defaultModel || "").trim();
    return {
      models,
      defaultModel: models.some((item) => item.id === requestedDefault) ? requestedDefault : models[0].id,
    };
  }

  function renderRetranslationModels() {
    const container = $("#retranslate-models");
    container.replaceChildren();
    retranslationModels.forEach((model) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-option";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-pressed", String(model.id === retranslationSelectedModel));
      button.setAttribute("aria-checked", String(model.id === retranslationSelectedModel));
      const name = document.createElement("strong");
      name.textContent = model.id;
      const detail = document.createElement("small");
      detail.textContent = `${model.provider}${model.supportsGenius ? " · Genius 注释" : ""}`;
      button.append(name, detail);
      button.addEventListener("click", () => {
        if (retranslationInFlight) return;
        retranslationSelectedModel = model.id;
        renderRetranslation();
      });
      container.append(button);
    });
  }

  function renderRetranslationComparison() {
    const container = $("#retranslate-comparison");
    container.replaceChildren();
    if (!editorState || !retranslationCandidate) return;
    const comparison = State.retranslationComparison(editorState, retranslationCandidate);
    const changedCount = comparison.filter((item) => item.changed).length;
    const summary = document.createElement("div");
    summary.className = "retranslate-diff-summary";
    summary.textContent = `${changedCount} 行修改 · ${comparison.length - changedCount} 行未变`;
    container.append(summary);
    comparison.forEach((item) => {
      const row = document.createElement("article");
      row.className = `retranslate-diff-row${item.changed ? " is-changed" : ""}`;

      const heading = document.createElement("header");
      heading.className = "retranslate-diff-row-heading";
      const lineNumber = document.createElement("span");
      lineNumber.className = "retranslate-diff-line-number";
      lineNumber.textContent = `第 ${String(item.index + 1).padStart(2, "0")} 行`;
      const state = document.createElement("span");
      state.className = "retranslate-diff-state";
      state.textContent = item.changed ? "已修改" : "未变化";
      heading.append(lineNumber, state);

      const source = document.createElement("div");
      source.className = "retranslate-diff-source";
      const sourceMarker = document.createElement("span");
      sourceMarker.className = "retranslate-diff-marker";
      sourceMarker.textContent = " ";
      sourceMarker.setAttribute("aria-hidden", "true");
      const sourceCopy = document.createElement("div");
      const sourceLabel = document.createElement("small");
      sourceLabel.textContent = "原文";
      const sourceText = document.createElement("p");
      sourceText.className = "retranslate-diff-source-text";
      sourceText.textContent = item.candidate.base || "（空行）";
      sourceCopy.append(sourceLabel, sourceText);
      source.append(sourceMarker, sourceCopy);

      const translations = document.createElement("div");
      translations.className = "retranslate-diff-translations";
      if (item.changed) {
        for (const [tagName, className, marker, label, text] of [
          ["del", "retranslate-diff-before", "−", "当前译文", item.current.translation],
          ["ins", "retranslate-diff-after", "+", "候选译文", item.candidate.translation],
        ]) {
          const change = document.createElement(tagName);
          change.className = className;
          const changeMarker = document.createElement("span");
          changeMarker.className = "retranslate-diff-marker";
          changeMarker.textContent = marker;
          changeMarker.setAttribute("aria-hidden", "true");
          const copy = document.createElement("div");
          const changeLabel = document.createElement("small");
          changeLabel.textContent = label;
          const changeText = document.createElement("p");
          changeText.className = `${className}-text`;
          changeText.textContent = text || "（无译文）";
          copy.append(changeLabel, changeText);
          change.append(changeMarker, copy);
          translations.append(change);
        }
      } else {
        const unchanged = document.createElement("div");
        unchanged.className = "retranslate-diff-unchanged";
        const marker = document.createElement("span");
        marker.className = "retranslate-diff-marker";
        marker.textContent = "=";
        marker.setAttribute("aria-hidden", "true");
        const copy = document.createElement("div");
        const label = document.createElement("small");
        label.textContent = "译文未变化";
        const text = document.createElement("p");
        text.textContent = item.candidate.translation || "（无译文）";
        copy.append(label, text);
        unchanged.append(marker, copy);
        translations.append(unchanged);
      }
      row.append(heading, source, translations);
      container.append(row);
    });
  }

  function renderRetranslation() {
    const hasCandidate = Boolean(retranslationCandidate);
    const currentStatic = editorState?.document?.lyrics?.static === true;
    const badge = $("#retranslate-static-badge");
    badge.textContent = currentStatic ? "static" : "非 static";
    badge.dataset.static = String(currentStatic);
    $("#retranslate-picker").hidden = hasCandidate;
    $("#retranslate-review").hidden = !hasCandidate;
    $("#retranslate-submit").hidden = hasCandidate;
    $("#retranslate-submit").disabled = Boolean(retranslationInFlight || !retranslationSelectedModel);
    $("#retranslate-submit").textContent = retranslationInFlight === "translate" ? "正在翻译…" : "生成候选";
    $("#retranslate-apply").hidden = !hasCandidate;
    $("#retranslate-apply-static").hidden = !hasCandidate;
    $("#retranslate-apply").disabled = Boolean(retranslationInFlight);
    $("#retranslate-apply-static").disabled = Boolean(retranslationInFlight);
    $("#retranslate-apply").textContent = retranslationInFlight === "apply" ? "正在保存…" : "应用";
    $("#retranslate-apply-static").textContent = retranslationInFlight === "apply-static" ? "正在保存…" : "应用并 static";
    if (hasCandidate) {
      $("#retranslate-provenance").textContent = [
        retranslationCandidate.model,
        retranslationCandidate.provider,
        retranslationCandidate.geniusAnnotations ? "已使用 Genius 注释" : "无 Genius 注释",
      ].filter(Boolean).join(" · ");
      renderRetranslationComparison();
    } else {
      renderRetranslationModels();
    }
    setRetranslationError(retranslationError);
  }

  async function openRetranslation() {
    if (!editorState || retranslationInFlight) return;
    const dialog = $("#retranslate-dialog");
    retranslationRevision += 1;
    const revision = retranslationRevision;
    retranslationModels = [];
    retranslationSelectedModel = "";
    retranslationCandidate = null;
    retranslationSourceSnapshot = "";
    retranslationInFlight = "models";
    retranslationError = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    renderRetranslation();
    try {
      const response = validateModelsResponse(await hostCommand({ command: "models" }));
      if (revision !== retranslationRevision || !(dialog.open || dialog.hasAttribute("open"))) return;
      retranslationModels = response.models;
      retranslationSelectedModel = response.defaultModel;
    } catch (error) {
      if (revision === retranslationRevision) retranslationError = error.message || "模型列表读取失败";
    } finally {
      if (revision === retranslationRevision) {
        retranslationInFlight = "";
        renderRetranslation();
      }
    }
  }

  async function submitRetranslation() {
    const dialog = $("#retranslate-dialog");
    if (!editorState || retranslationInFlight || !retranslationSelectedModel) return;
    const revision = retranslationRevision;
    const originalHash = editorState.document.hash;
    const originalTrackIdentity = trackIdentity(editorState.document.track);
    const sourceSnapshot = State.serializeState(editorState);
    let request;
    try {
      request = State.createRetranslationRequest(editorState, retranslationSelectedModel);
    } catch (error) {
      setRetranslationError(error.message);
      return;
    }
    retranslationInFlight = "translate";
    retranslationError = "";
    renderRetranslation();
    try {
      const response = await hostCommand({ command: "translate", payload: request });
      if (revision !== retranslationRevision || !(dialog.open || dialog.hasAttribute("open")) || !editorState
        || editorState.document.hash !== originalHash
        || trackIdentity(editorState.document.track) !== originalTrackIdentity
        || State.serializeState(editorState) !== sourceSnapshot) return;
      retranslationCandidate = State.validateRetranslationResponse(editorState, response);
      retranslationSourceSnapshot = sourceSnapshot;
    } catch (error) {
      if (revision === retranslationRevision) retranslationError = error.message || "整首重译失败";
    } finally {
      if (revision === retranslationRevision) {
        retranslationInFlight = "";
        renderRetranslation();
      }
    }
  }

  async function applyRetranslation(makeStatic) {
    const dialog = $("#retranslate-dialog");
    if (!editorState || !retranslationCandidate || retranslationInFlight) return;
    if (State.serializeState(editorState) !== retranslationSourceSnapshot) {
      setRetranslationError("当前歌词已变化，请取消并重新生成候选");
      return;
    }
    const revision = retranslationRevision;
    const originalHash = editorState.document.hash;
    const originalTrackIdentity = trackIdentity(editorState.document.track);
    const payload = State.createRetranslationSavePayload(editorState, retranslationCandidate, makeStatic);
    retranslationInFlight = makeStatic ? "apply-static" : "apply";
    retranslationError = "";
    renderRetranslation();
    try {
      const result = await hostCommand({ command: "save", notify: false, payload });
      if (revision !== retranslationRevision || !(dialog.open || dialog.hasAttribute("open")) || !editorState
        || editorState.document.hash !== originalHash
        || trackIdentity(editorState.document.track) !== originalTrackIdentity
        || State.serializeState(editorState) !== retranslationSourceSnapshot) return;
      mutate(() => State.commitSavedRetranslation(editorState, retranslationCandidate, makeStatic, result?.hash));
      dialog.close();
      status(makeStatic ? "重译候选已应用并标记 static" : "重译候选已应用");
    } catch (error) {
      if (revision === retranslationRevision) retranslationError = error.message || "重译候选保存失败";
    } finally {
      if (revision === retranslationRevision) {
        retranslationInFlight = "";
        if (dialog.open || dialog.hasAttribute("open")) renderRetranslation();
      }
    }
  }

  function setSegmentStatus(message, error) {
    const output = $("#segments-status");
    output.textContent = String(message || "");
    output.classList.toggle("is-error", Boolean(error));
  }

  function segmentField(labelText, value, field, type) {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.className = "field-label";
    caption.textContent = labelText;
    const input = document.createElement("input");
    input.type = type || "text";
    input.value = String(value == null ? "" : value);
    input.dataset.segmentField = field;
    if (input.type === "number") {
      input.min = "0";
      input.max = "86400000";
      input.step = "1";
      input.inputMode = "numeric";
    }
    label.append(caption, input);
    return label;
  }

  function segmentTimeField(labelText, value, field) {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.className = "field-label";
    caption.textContent = labelText;
    const controls = document.createElement("div");
    controls.className = "segment-time-control";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "86400000";
    input.step = "1";
    input.inputMode = "numeric";
    input.value = String(value == null ? "" : value);
    input.dataset.segmentField = field;
    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "ghost-button";
    capture.dataset.segmentAction = field === "startMs" ? "capture-start" : "capture-end";
    capture.textContent = "取当前";
    controls.append(input, capture);
    label.append(caption, controls);
    return label;
  }

  function renderSegmentEditor() {
    const list = $("#segments-list");
    const revision = $("#segments-revision");
    const count = $("#segments-count");
    const saveButton = $("#segments-save");
    const conflictButton = $("#segments-load-conflict");
    const addButton = $("#segment-add");
    list.textContent = "";
    const rules = segmentSession?.rules || [];
    const playerMatchesTrack = Boolean(editorState
      && editorState.player.trackId === editorState.document.track.trackId);
    revision.textContent = segmentSession ? `revision ${segmentSession.document.revision}` : "尚未载入";
    count.textContent = `${rules.length} 个片段`;
    addButton.disabled = segmentLoading || segmentSaving || !segmentSession || Boolean(segmentSession.conflict);
    saveButton.disabled = segmentLoading || segmentSaving || !segmentSession?.dirty || Boolean(segmentSession?.conflict);
    saveButton.textContent = segmentSaving ? "正在保存…" : "保存规则";
    conflictButton.hidden = !segmentSession?.conflict;

    if (segmentLoading) {
      const empty = document.createElement("p");
      empty.className = "segment-empty";
      empty.textContent = "正在载入片段规则…";
      list.appendChild(empty);
    } else if (!rules.length) {
      const empty = document.createElement("p");
      empty.className = "segment-empty";
      empty.textContent = "当前歌曲还没有跳过片段";
      list.appendChild(empty);
    } else {
      rules.forEach((rule) => {
        const article = document.createElement("article");
        article.className = "segment-rule";
        article.dataset.segmentId = String(rule.id || "");
        const header = document.createElement("div");
        header.className = "segment-rule-header";
        const enabledLabel = document.createElement("label");
        enabledLabel.className = "segment-enabled";
        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = rule.enabled === true;
        enabled.dataset.segmentField = "enabled";
        const id = document.createElement("code");
        id.textContent = String(rule.id || "");
        enabledLabel.append(enabled, id);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-button danger-button";
        remove.dataset.segmentAction = "delete";
        remove.setAttribute("aria-label", "删除片段");
        remove.setAttribute("title", "删除片段");
        const icon = document.createElement("span");
        icon.className = "icon-slot";
        icon.dataset.icon = "trash";
        remove.appendChild(icon);
        header.append(enabledLabel, remove);
        const fields = document.createElement("div");
        fields.className = "segment-rule-fields";
        fields.append(
          segmentField("分类", rule.category, "category"),
          segmentField("标签", rule.label, "label"),
        );
        const times = document.createElement("div");
        times.className = "segment-time-grid";
        times.append(
          segmentTimeField("开始 (ms)", rule.startMs, "startMs"),
          segmentTimeField("结束 (ms)", rule.endMs, "endMs"),
        );
        article.append(header, fields, times);
        if (!playerMatchesTrack) {
          article.querySelectorAll('[data-segment-action^="capture-"]').forEach((control) => { control.disabled = true; });
        }
        if (segmentSaving || segmentSession.conflict) {
          article.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
        }
        list.appendChild(article);
      });
      root.LyricsEditorIcons?.hydrate(list);
    }
    setSegmentStatus(segmentError, Boolean(segmentError));
  }

  async function openSegmentEditor() {
    if (!editorState) return;
    const dialog = $("#segments-dialog");
    const revision = ++segmentRequestRevision;
    segmentSession = null;
    segmentLoading = true;
    segmentSaving = false;
    segmentError = "";
    renderSegmentEditor();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const trackId = editorState.document.track.trackId;
    try {
      const response = await hostCommand({ command: "segmentsGet", trackId });
      if (revision !== segmentRequestRevision || editorState?.document?.track?.trackId !== trackId) return;
      segmentSession = State.createSegmentSession(response, trackId);
    } catch (error) {
      if (revision === segmentRequestRevision) segmentError = error.message || "片段规则载入失败";
    } finally {
      if (revision === segmentRequestRevision) {
        segmentLoading = false;
        renderSegmentEditor();
      }
    }
  }

  function addSegment() {
    if (!segmentSession || segmentSession.conflict) return;
    const startMs = Math.min(86_399_999, currentPosition());
    State.addSegmentRule(segmentSession, { startMs, endMs: Math.min(86_400_000, startMs + 10_000) });
    segmentError = "";
    renderSegmentEditor();
  }

  function updateSegmentFromControl(target) {
    if (!segmentSession || segmentSession.conflict) return;
    const row = target.closest("[data-segment-id]");
    const field = target.dataset.segmentField;
    if (!row || !field) return;
    State.updateSegmentRule(segmentSession, row.dataset.segmentId, {
      [field]: target.type === "checkbox" ? target.checked : target.value,
    });
    segmentError = "";
    $("#segments-save").disabled = false;
    setSegmentStatus("", false);
  }

  function segmentListAction(event) {
    const button = event.target.closest("[data-segment-action]");
    const row = button?.closest("[data-segment-id]");
    if (!button || !row || !segmentSession || segmentSession.conflict) return;
    const id = row.dataset.segmentId;
    if (button.dataset.segmentAction === "delete") {
      State.removeSegmentRule(segmentSession, id);
    } else {
      if (editorState.player.trackId !== editorState.document.track.trackId) {
        segmentError = "当前播放器曲目与编辑文档不一致，无法读取播放位置。";
        renderSegmentEditor();
        return;
      }
      State.updateSegmentRule(segmentSession, id, {
        [button.dataset.segmentAction === "capture-start" ? "startMs" : "endMs"]: currentPosition(),
      });
    }
    segmentError = "";
    renderSegmentEditor();
  }

  async function saveSegments() {
    if (!editorState || !segmentSession || segmentSaving || segmentSession.conflict) return;
    const trackId = editorState.document.track.trackId;
    const revision = segmentRequestRevision;
    let payload;
    try {
      payload = State.toSegmentPutPayload(segmentSession);
    } catch (error) {
      segmentError = error.message || "片段规则无效";
      renderSegmentEditor();
      return;
    }
    segmentSaving = true;
    segmentError = "";
    renderSegmentEditor();
    try {
      const response = await hostCommand({ command: "segmentsPut", payload });
      if (revision !== segmentRequestRevision || editorState?.document?.track?.trackId !== trackId) return;
      State.commitSegmentDocument(segmentSession, response, trackId);
      status("片段规则已保存");
    } catch (error) {
      if (revision !== segmentRequestRevision) return;
      if (error?.payload?.reason === "revision-conflict" && error.payload.document) {
        State.recordSegmentConflict(segmentSession, error.payload, trackId);
        segmentError = "服务端规则已经变化。本地修改仍保留；请载入服务端版本后重新编辑。";
      } else {
        segmentError = error.message || "片段规则保存失败";
      }
    } finally {
      if (revision === segmentRequestRevision) {
        segmentSaving = false;
        renderSegmentEditor();
      }
    }
  }

  function loadSegmentConflict() {
    if (!segmentSession?.conflict) return;
    State.loadSegmentConflict(segmentSession);
    segmentError = "";
    renderSegmentEditor();
    status("已载入服务端片段规则");
  }

  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => bridge({ command: "draft", serialized: State.serializeState(editorState) }), 350); }

  function save() {
    if (!editorState) return;
    const validationError = State.validateForSave(editorState);
    if (validationError) { status(validationError, true); return; }
    status("正在保存…");
    bridge({ command: "save", payload: State.toSavePayload(editorState) });
  }

  function undo() {
    if (!editorState || !history.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    future.push(State.serializeState(editorState));
    State.restoreState(editorState, history.pop()); render(); scheduleDraft();
  }
  function redo() {
    if (!editorState || !future.length) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    history.push(State.serializeState(editorState));
    State.restoreState(editorState, future.pop()); render(); scheduleDraft();
  }

  function bind() {
    if (root.LyricsEditorIcons) root.LyricsEditorIcons.hydrate(document);
    $("#play-button").addEventListener("click", () => bridge({ command: editorState?.player?.isPlaying ? "pause" : "play" }));
    $("#position-slider").addEventListener("input", (event) => {
      updateSliderFill(event.target);
      bridge({ command: "seek", positionMs: Number(event.target.value) || 0 });
    });
    $("#cue-toggle").addEventListener("click", () => { editorState.cueEnabled = !editorState.cueEnabled; renderTransport(); scheduleDraft(); });
    $("#cue-word-toggle").addEventListener("click", () => { editorState.cueWordMode = !editorState.cueWordMode; renderTransport(); scheduleDraft(); });
    $("#cue-start").addEventListener("click", cuePrimary); $("#cue-end").addEventListener("click", cueEnd); $("#play-line").addEventListener("click", previewCurrent); $("#next-line").addEventListener("click", moveNext);
    $("#add-before").addEventListener("click", addBefore);
    $("#add-after").addEventListener("click", addAfter);
    $("#delete-current").addEventListener("click", removeCurrent);
    $("#save-button").addEventListener("click", save); $("#undo-button").addEventListener("click", undo); $("#redo-button").addEventListener("click", redo);
    $("#lrc-import-button").addEventListener("click", openLRCImport);
    $("#lrc-import-input").addEventListener("input", (event) => {
      lrcImportRevision += 1;
      lrcImportResult = State.parseLRC(event.target.value);
      renderLRCImport();
    });
    $("#lrc-import-confirm").addEventListener("click", confirmLRCImport);
    $("#lrc-import-translate").addEventListener("click", submitLRCTranslation);
    $("#lrc-import-dialog").addEventListener("close", () => {
      lrcImportRevision += 1;
      lrcImportResult = null;
    });
    $("#retranslate-button").addEventListener("click", openRetranslation);
    $("#retranslate-submit").addEventListener("click", submitRetranslation);
    $("#retranslate-apply").addEventListener("click", () => applyRetranslation(false));
    $("#retranslate-apply-static").addEventListener("click", () => applyRetranslation(true));
    $("#retranslate-dialog").addEventListener("close", () => {
      retranslationRevision += 1;
      retranslationModels = [];
      retranslationSelectedModel = "";
      retranslationCandidate = null;
      retranslationSourceSnapshot = "";
      retranslationInFlight = "";
      retranslationError = "";
    });
    $("#segments-button").addEventListener("click", openSegmentEditor);
    $("#segment-add").addEventListener("click", addSegment);
    $("#segments-list").addEventListener("input", (event) => updateSegmentFromControl(event.target));
    $("#segments-list").addEventListener("change", (event) => updateSegmentFromControl(event.target));
    $("#segments-list").addEventListener("click", segmentListAction);
    $("#segments-save").addEventListener("click", saveSegments);
    $("#segments-load-conflict").addEventListener("click", loadSegmentConflict);
    $("#segments-dialog").addEventListener("close", () => {
      segmentRequestRevision += 1;
      segmentSession = null;
      segmentLoading = false;
      segmentSaving = false;
      segmentError = "";
    });
    $("#dock-cue-primary").addEventListener("click", cuePrimary);
    $("#dock-cue-end").addEventListener("click", cueEnd);
    $("#dock-next-line").addEventListener("click", moveNext);
    $("#dock-add-before").addEventListener("click", addBefore);
    $("#dock-add-after").addEventListener("click", addAfter);
    $("#dock-delete-current").addEventListener("click", removeCurrent);
    document.querySelectorAll(".mobile-workspace-tabs [data-mobile-view]").forEach((button) => {
      button.addEventListener("click", () => activateMobileView(button.dataset.mobileView));
    });
    document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => mutate(() => State.setSyncType(editorState, button.dataset.mode))));
    $("#current-base").addEventListener("input", (event) => updateCurrent({ base: event.target.value }));
    $("#current-translation").addEventListener("input", (event) => updateCurrent({ translation: event.target.value }));
    $("#current-start").addEventListener("input", (event) => updateCurrent({ startTimeMs: event.target.value }));
    $("#current-end").addEventListener("input", (event) => updateCurrent({ endTimeMs: event.target.value }));
    $("#current-syllables").addEventListener("input", (event) => updateCurrent({ syllables: event.target.value.split(/\r?\n/).filter(Boolean) }));
    document.addEventListener("pointerdown", (event) => {
      // closest() keeps inner span/svg pointer targets tied to their button.
      pointerControl = event.target?.closest?.('button, input[type="range"]') || null;
    });
    document.addEventListener("pointerup", (event) => {
      const releasedControl = event.target?.closest?.('button, input[type="range"]') || null;
      const control = releasedControl === pointerControl ? releasedControl : pointerControl;
      // The pointerdown owner covers drags released outside the control and
      // prevents an unrelated pointerup from disturbing keyboard-only focus.
      if (control === document.activeElement) control.blur();
      pointerControl = null;
    });
    document.addEventListener("pointercancel", () => {
      pointerControl = null;
    });
    document.addEventListener("keydown", (event) => {
      if (!editorState || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.target instanceof HTMLElement
        && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName) || event.target.isContentEditable)) return;
      const action = State.resolveCueShortcut(event, editorState);
      if (!action) return;
      event.preventDefault();
      if (action === "previous-line") movePrevious();
      else if (action === "next-line") moveNext();
      else if (action === "preview-current") previewCurrent();
      else if (action === "cue-primary") cuePrimary();
      else if (action === "cue-end") cueEnd();
    }, true);
  }

  root.LyricsTimelineEditor = {
    loadDocument(payload) { retranslationRevision += 1; segmentRequestRevision += 1; editorState = State.createState(payload); history = []; future = []; render(); bridge({ command: "getPlayerState" }); return true; },
    serializeState() { return editorState ? State.serializeState(editorState) : ""; },
    restoreState(serialized) { if (!editorState) return false; State.restoreState(editorState, serialized); render(); return true; },
    onPlayerState(snapshot) { if (!editorState || !snapshot) return; editorState.player = { ...editorState.player, ...snapshot }; renderTransport(); },
    onSaveResult(result) { if (result?.ok) { if (result.hash) editorState.document.hash = result.hash; status("已保存"); scheduleDraft(); } else status(`保存失败：${result?.reason || "unknown"}`, true); },
    onCommandResult(result) {
      const requestId = String(result?.requestId || "");
      const pending = nativeRequests.get(requestId);
      if (!pending) return false;
      nativeRequests.delete(requestId);
      clearTimeout(pending.timeout);
      if (result?.ok === true) pending.resolve(result.payload);
      else pending.reject(commandError(result?.error, "歌词服务请求失败"));
      return true;
    },
  };

  if (!root.webkit?.messageHandlers?.timelineEditor && root.LyricsTimelineBrowserHost) {
    browserHost = root.LyricsTimelineBrowserHost.createHost({
      fetchImpl: root.fetch.bind(root),
      applyDocument(document) { root.LyricsTimelineEditor.loadDocument(document); },
      onSaveResult(result) { root.LyricsTimelineEditor.onSaveResult(result); },
      postPlayerCommand(command) {
        if (browserParent && browserParentOrigin) {
          browserParent.postMessage({ type: "mitm-lyrics-player-command", ...command }, browserParentOrigin);
        }
      },
    });
    root.addEventListener("message", (event) => {
      const payload = event.data;
      if (!payload || event.source !== root.parent) return;
      if (payload.type === "mitm-lyrics-editor-bootstrap" && payload.mode === "timeline") {
        browserParent = event.source;
        browserParentOrigin = event.origin;
        status("正在载入当前曲目…");
        browserHost.bootstrap(payload).then(() => status("当前曲目已载入")).catch((error) => {
          status(error.message || "当前曲目载入失败", true);
        });
      } else if (payload.type === "mitm-lyrics-player-state" && payload.snapshot) {
        root.LyricsTimelineEditor.onPlayerState(payload.snapshot);
      }
    });
    try { root.parent.postMessage({ type: "mitm-lyrics-editor-ready", mode: "timeline" }, "*"); } catch (_) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true }); else bind();
})(typeof globalThis !== "undefined" ? globalThis : this, typeof LyricsTimelineState !== "undefined" ? LyricsTimelineState : null);
