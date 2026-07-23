(function (root, State) {
  "use strict";
  if (!root || !State) return;

  const $ = (selector) => document.querySelector(selector);
  let editorState = null;
  let history = [];
  let future = [];
  let previewTimer = null;
  let draftTimer = null;
  const inputIds = ["current-base", "current-translation", "current-start", "current-end", "current-syllables"];

  function bridge(message) {
    try { root.webkit?.messageHandlers?.timelineEditor?.postMessage(message); } catch (_) {}
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
  function pushHistory() {
    if (!editorState) return;
    try { history.push(State.serializeState(editorState)); if (history.length > 40) history.shift(); future = []; } catch (_) {}
  }
  function mutate(callback) { pushHistory(); callback(); render(); scheduleDraft(); }

  function renderTransport() {
    const player = editorState?.player || { positionMs: 0, durationMs: 0, isPlaying: false };
    const sameTrack = Boolean(editorState && player.trackId === editorState.document.track.trackId);
    $("#position-label").textContent = formatMs(player.positionMs);
    $("#duration-label").textContent = formatMs(player.durationMs);
    const slider = $("#position-slider");
    slider.max = String(Math.max(0, Number(player.durationMs) || 0));
    slider.value = String(Math.min(Number(slider.max), Math.max(0, Number(player.positionMs) || 0)));
    $("#play-button").textContent = player.isPlaying ? "⏸" : "▶";
    $("#play-button").disabled = !sameTrack || (player.isPlaying ? player.canPause !== true : player.canPlay !== true);
    $("#position-slider").disabled = !sameTrack || player.canSeek !== true;
    $("#preview-line").disabled = !sameTrack || player.canSeek !== true || player.canPlay !== true;
    $("#cue-start").disabled = !sameTrack;
    $("#cue-end").disabled = !sameTrack;
    $("#cue-toggle").textContent = `打点：${editorState?.cueEnabled ? "开" : "关"}`;
    const wordMode = editorState?.cueWordMode === true;
    const tokens = State.cueTokens(State.splitTranslation(currentLine()?.words || "").base);
    const completed = State.normalizeSyllables(currentLine()?.syllables).length;
    $("#cue-word-toggle").textContent = wordMode ? `逐词：${Math.min(completed, tokens.length)}/${tokens.length}` : "逐词：关";
    $("#cue-start").textContent = wordMode ? "打下一个词" : "写入 start";
    $("#cue-end").textContent = wordMode ? "完成本行" : "写入 end";
  }

  function renderCurrent() {
    const line = currentLine();
    const index = editorState ? editorState.selectedIndex : 0;
    $("#current-index").textContent = `第 ${index + 1} 行`;
    for (const id of inputIds) {
      const element = $(`#${id}`);
      if (!element) continue;
      const value = id === "current-base" ? State.splitTranslation(line?.words || "").base
        : id === "current-translation" ? State.splitTranslation(line?.words || "").translation
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
      const parts = State.splitTranslation(line.words);
      const base = document.createElement("strong"); base.textContent = parts.base || "（空行）";
      const translation = document.createElement("small"); translation.textContent = parts.translation;
      copy.append(base, translation);
      const times = document.createElement("span"); times.className = "line-times"; times.textContent = `${line.startTimeMs || "—"}\n${line.endTimeMs || "—"}`;
      row.append(number, copy, times);
      row.addEventListener("click", () => { editorState.selectedIndex = index; render(); scheduleDraft(); });
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
  function cueStart() { updateCurrent({ startTimeMs: String(currentPosition()) }); moveNext(); }
  function cueEnd() { updateCurrent({ endTimeMs: String(currentPosition()) }); moveNext(); }
  function cueNextWord() {
    const line = currentLine();
    const tokens = State.cueTokens(State.splitTranslation(line?.words || "").base);
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
  function moveNext() { if (!editorState) return; editorState.selectedIndex = Math.min(lines().length - 1, editorState.selectedIndex + 1); render(); scheduleDraft(); }

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
    $("#play-button").addEventListener("click", () => bridge({ command: editorState?.player?.isPlaying ? "pause" : "play" }));
    $("#position-slider").addEventListener("input", (event) => bridge({ command: "seek", positionMs: Number(event.target.value) || 0 }));
    $("#cue-toggle").addEventListener("click", () => { editorState.cueEnabled = !editorState.cueEnabled; renderTransport(); scheduleDraft(); });
    $("#cue-word-toggle").addEventListener("click", () => { editorState.cueWordMode = !editorState.cueWordMode; renderTransport(); scheduleDraft(); });
    $("#cue-start").addEventListener("click", cuePrimary); $("#cue-end").addEventListener("click", cueEnd); $("#preview-line").addEventListener("click", previewCurrent); $("#next-line").addEventListener("click", moveNext);
    $("#add-before").addEventListener("click", () => mutate(() => State.addLine(editorState, editorState.selectedIndex)));
    $("#add-after").addEventListener("click", () => mutate(() => State.addLine(editorState, editorState.selectedIndex + 1)));
    $("#delete-current").addEventListener("click", () => mutate(() => State.removeLine(editorState, editorState.selectedIndex)));
    $("#save-button").addEventListener("click", save); $("#undo-button").addEventListener("click", undo); $("#redo-button").addEventListener("click", redo);
    document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => mutate(() => State.setSyncType(editorState, button.dataset.mode))));
    $("#current-base").addEventListener("input", (event) => updateCurrent({ base: event.target.value }));
    $("#current-translation").addEventListener("input", (event) => updateCurrent({ translation: event.target.value }));
    $("#current-start").addEventListener("input", (event) => updateCurrent({ startTimeMs: event.target.value }));
    $("#current-end").addEventListener("input", (event) => updateCurrent({ endTimeMs: event.target.value }));
    $("#current-syllables").addEventListener("input", (event) => updateCurrent({ syllables: event.target.value.split(/\r?\n/).filter(Boolean) }));
    document.addEventListener("keydown", (event) => {
      if (!editorState?.cueEnabled || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (event.key.toLowerCase() === "w") { event.preventDefault(); cuePrimary(); }
      if (event.key.toLowerCase() === "e") { event.preventDefault(); cueEnd(); }
      if (event.key === "ArrowDown") { event.preventDefault(); moveNext(); }
      if (event.key === "ArrowUp") { event.preventDefault(); editorState.selectedIndex = Math.max(0, editorState.selectedIndex - 1); render(); scheduleDraft(); }
    }, true);
  }

  root.LyricsTimelineEditor = {
    loadDocument(payload) { editorState = State.createState(payload); history = []; future = []; render(); bridge({ command: "getPlayerState" }); return true; },
    serializeState() { return editorState ? State.serializeState(editorState) : ""; },
    restoreState(serialized) { if (!editorState) return false; State.restoreState(editorState, serialized); render(); return true; },
    onPlayerState(snapshot) { if (!editorState || !snapshot) return; editorState.player = { ...editorState.player, ...snapshot }; renderTransport(); },
    onSaveResult(result) { if (result?.ok) { if (result.hash) editorState.document.hash = result.hash; status("已保存"); scheduleDraft(); } else status(`保存失败：${result?.reason || "unknown"}`, true); },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true }); else bind();
})(typeof globalThis !== "undefined" ? globalThis : this, typeof LyricsTimelineState !== "undefined" ? LyricsTimelineState : null);
