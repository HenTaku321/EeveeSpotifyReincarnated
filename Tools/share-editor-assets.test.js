"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ShareState = require("../layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor/editor-state.js");
const ShareRenderer = require("../layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor/renderer.js");
const ShareApp = require("../layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor/app.js");
const TimelineState = require("../layout/Library/Application Support/EeveeSpotify.bundle/TimelineEditor/editor-state.js");
const SHARE_BUNDLE = path.join(__dirname, "../layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor");

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const HASH = "0123456789abcdef".repeat(4);

function readSource(name) {
  return fs.readFileSync(path.join(__dirname, "../Sources/EeveeSpotify/ShareEditor", name), "utf8");
}

test("standalone ships distinct licensed variable faces for classic and rounded Canvas text", () => {
  const style = fs.readFileSync(path.join(SHARE_BUNDLE, "style.css"), "utf8");
  const renderer = fs.readFileSync(path.join(SHARE_BUNDLE, "renderer.js"), "utf8");
  const app = fs.readFileSync(path.join(SHARE_BUNDLE, "app.js"), "utf8");
  assert.match(style, /font-family:\s*"MITM Editor Sans"/);
  assert.match(style, /inter-latin-wght-normal\.woff2/);
  assert.match(style, /plus-jakarta-sans-latin-wght-normal\.woff2/);
  assert.match(renderer, /classic:\s*'"MITM Editor Sans"/);
  assert.match(renderer, /rounded:\s*'"MITM Poster Rounded"/);
  assert.doesNotMatch(renderer, /classic:\s*'Arial\b/);
  assert.match(app, /function loadEditorFonts\(fontSet\)/);
  for (const name of [
    "fonts/inter-latin-wght-normal.woff2",
    "fonts/OFL-Inter.txt",
    "fonts/plus-jakarta-sans-latin-wght-normal.woff2",
    "fonts/OFL-Plus-Jakarta-Sans.txt",
  ]) {
    assert.equal(fs.existsSync(path.join(SHARE_BUNDLE, name)), true, `${name} must ship in the standalone bundle`);
  }
});

test("standalone mobile share editor keeps every root track inside the WebView", () => {
  const style = fs.readFileSync(path.join(SHARE_BUNDLE, "style.css"), "utf8");
  const mobile = style.slice(style.indexOf("@media (max-width: 760px)"));

  assert.match(style, /\.app\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(style, /\.app\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(style, /\.app-title\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*overflow:\s*hidden/s);
  assert.match(style, /\.track-summary\s*\{[^}]*flex:\s*1\s+1\s+0/s);
  assert.match(
    mobile,
    /\.mobile-tool-dock\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
  );

  const templateRule = mobile.match(/\.template-switch\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(templateRule, /display:\s*grid/);
  assert.match(templateRule, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(templateRule, /width:\s*100%/);

  const templateButtonRule = mobile.match(/\.template-switch\s+button\s*\{[^}]*\}/s)?.[0] || "";
  assert.match(templateButtonRule, /min-width:\s*0/);
  assert.match(templateButtonRule, /width:\s*100%/);
});

test("native bridge keeps lyrics documents at 8 MiB while allowing 32 MiB PNG exports", () => {
  const bridge = readSource("LyricsShareEditorBridge.swift");
  const controller = readSource("LyricsShareEditorViewController.swift");

  assert.match(bridge, /static let maximumBytes = 32 \* 1024 \* 1024/);
  assert.match(bridge, /PNG 数据大小超过 32 MiB 限制/);
  assert.match(bridge, /static let maximumDimension = 4096/);
  assert.match(bridge, /static let maximumPixels = 16_777_216/);
  assert.match(controller, /private static let maximumDocumentBytes = 8 \* 1024 \* 1024/);
  assert.match(controller, /LyricsShareEditorSessionDelegate\(maximumBytes: Self\.maximumDocumentBytes\)/);
  assert.match(controller, /encodedDocument\.count > Self\.maximumDocumentBytes/);
  assert.match(controller, /data\.count <= Self\.maximumDocumentBytes/);
  assert.doesNotMatch(controller, /LyricsShareEditorPNG\.maximumBytes/);
});

test("native iOS source logos override the file URL fallback without entering editor state", () => {
  assert.equal(ShareApp.sourceLogoURL("original"), "./source-logo");
  assert.equal(ShareApp.sourceLogoURL("white"), "./source-logo?variant=white");
  assert.equal(typeof ShareApp.setSourceLogos, "function");
  assert.equal(typeof ShareApp.publicApi.setSourceLogos, "function");

  ShareApp.publicApi.setSourceLogos({ original: TINY_PNG });
  assert.equal(ShareApp.sourceLogoURL("original"), TINY_PNG);
  assert.equal(ShareApp.sourceLogoURL("white"), TINY_PNG);

  const state = ShareState.createEditorState({
    source: "github",
    hash: HASH,
    track: { trackId: "track-1", title: "Title", artist: "Artist", album: "Album" },
    lyrics: { lines: [{ words: "Line" }], alternatives: [] },
  });
  assert.equal(ShareState.serializeState(state).includes(TINY_PNG), false);

  assert.throws(
    () => ShareApp.publicApi.setSourceLogos({ original: "https://example.test/logo.png" }),
    /base64|PNG|JPEG|WebP|图片/i,
  );
  ShareApp.publicApi.setSourceLogos(null);
  assert.equal(ShareApp.sourceLogoURL("original"), "./source-logo");

  const configuration = readSource("LyricsShareEditorConfiguration.swift");
  const controller = readSource("LyricsShareEditorViewController.swift");
  assert.match(configuration, /share-editor\/source-logo/);
  assert.match(controller, /sourceLogoLoader\.resolve/);
  assert.match(controller, /window\.ShareEditor\.setSourceLogos/);
});

test("captured artwork remains a cover without becoming the default background", () => {
  const state = ShareState.createEditorState({
    source: "github",
    hash: HASH,
    track: { trackId: "track-1", title: "Title", artist: "Artist", album: "Album", coverUrl: TINY_PNG },
    lyrics: { lines: [{ words: "Line" }], alternatives: [] },
  });
  assert.equal(state.document.track.coverUrl, TINY_PNG);
  assert.equal(state.media.useTrackArtworkAsBackground, false);

  const legacyProject = JSON.parse(ShareState.serializeState(state));
  delete legacyProject.media.useTrackArtworkAsBackground;
  assert.equal(ShareState.restoreState(legacyProject).media.useTrackArtworkAsBackground, false);

  legacyProject.media.useTrackArtworkAsBackground = true;
  assert.equal(ShareState.restoreState(legacyProject).media.useTrackArtworkAsBackground, true);
});

test("share editor presents combined translations separately and materializes v2 words", () => {
  let state = ShareState.createEditorState({
    source: "github",
    hash: HASH,
    track: { trackId: "track-1", title: "Title", artist: "Artist", album: "Album" },
    lyrics: {
      lines: [{ words: "Original(译文)" }],
      alternatives: [{
        language: "unknown",
        contentType: "opaque-metadata",
        lines: ["opaque"],
        custom: { nested: ["keep", { value: 7 }] },
      }],
    },
    selectedLineIndices: [0],
  });
  assert.deepEqual(ShareState.getSelectedLines(state)[0], {
    index: 0,
    text: "Original(译文)",
    base: "Original",
    translation: "译文",
  });
  state = ShareState.reduceEditorState(state, {
    type: "setLineText",
    index: 0,
    text: "Changed(新译文)",
  });
  const project = JSON.parse(ShareState.serializeState(state));
  assert.equal(project.version, ShareState.PROJECT_VERSION);
  assert.equal(project.document.lyrics.lines[0].words, "Changed(新译文)");
  assert.equal(Object.prototype.hasOwnProperty.call(project.document.lyrics.lines[0], "text"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(project, "edits"), false);
  assert.deepEqual(state.document.lyrics.alternatives, [{
    language: "unknown",
    contentType: "opaque-metadata",
    lines: ["opaque"],
    custom: { nested: ["keep", { value: 7 }] },
  }]);
});

test("share editor preserves scalar, object, and array alternatives as opaque metadata", () => {
  for (const alternatives of [
    "opaque",
    { custom: { nested: ["keep", 7] } },
    [{ language: "unknown", lines: ["do-not-read"] }],
  ]) {
    const state = ShareState.createEditorState({
      source: "github",
      hash: HASH,
      track: { trackId: "track-1", title: "Title", artist: "Artist", album: "Album" },
      lyrics: { lines: [{ words: "Original(译文)" }], alternatives },
      selectedLineIndices: [0],
    });
    const restored = ShareState.restoreState(ShareState.serializeState(state));
    assert.deepEqual(restored.document.lyrics.alternatives, alternatives);
  }
});

test("share editor poster keeps six long base lyrics paired with short Chinese translations", () => {
  const pairs = [
    ["Chamber echoing with dust through corridors beyond the silent altar", "密室回荡着尘埃"],
    ["Drifting through beams of light beneath a sky without an ending", "飘过道道光束"],
    ["Shadows cast upon the stones where ancient voices wait in silence", "阴影投落石上"],
    ["Temple doors reveal the night and every constellation burning", "神殿之门显露夜空"],
    ["Surging magnitude beneath the crushing weight of all the stars", "群星重压下涌动"],
    ["Suffocating density of gravity's well surrounds the final chamber", "重力深井令人窒息"],
  ];
  const state = ShareState.createEditorState({
    source: "github",
    hash: HASH,
    track: { trackId: "overflow", title: "Overflow", artist: "Artist", album: "Album" },
    lyrics: {
      language: "en",
      lines: pairs.map(([base, translation]) => ({ words: `${base}(${translation})` })),
      alternatives: [],
    },
    selectedLineIndices: pairs.map((_pair, index) => index),
  });
  state.template = "poster";
  state.style = { ...state.style, fontType: "rounded", textAlignment: "center", textColor: "#ffffff" };
  const context = {
    font: "",
    measureText: (value) => ({ width: String(value).length * 6.5 }),
  };
  const metrics = ShareRenderer.resolveTemplate("poster");
  const layout = ShareRenderer.createLyricsLayout(context, state, metrics, {
    fontModes: { classic: "custom", rounded: "custom" },
  });

  assert.equal(layout.groups.length, pairs.length);
  layout.groups.forEach((group, index) => {
    assert(group.rows.length >= 1, `base lyric ${index} must remain visible`);
    assert.equal(group.translationRows.join(""), pairs[index][1], `translation ${index} must remain visible`);
  });
  assert(
    layout.height <= metrics.lyricsBottom - metrics.lyricsTop + 0.001,
    `six-group poster layout exceeds the lyric band: ${layout.height}`,
  );
});

function timelineFixture() {
  return {
    ok: true,
    hash: HASH,
    track: { trackId: "6squLDyXKXZRgcJ8sjC0XG", title: "Title", artist: "Artist", album: "Album" },
    lyrics: {
      lyrics: {
        syncType: "LINE_SYNCED",
        lines: [
          { startTimeMs: "100", endTimeMs: "900", words: "Original (旧译文)", syllables: [] },
          { startTimeMs: "900", endTimeMs: "1800", words: "Second line", syllables: [] },
        ],
        alternatives: [{ language: "unknown", contentType: "metadata", lines: ["opaque-1", "opaque-2"] }],
      },
    },
  };
}

test("timeline keeps translations combined in words and alternatives opaque", () => {
  const state = TimelineState.createState(timelineFixture());
  const expectedAlternatives = JSON.parse(JSON.stringify(state.document.lyrics.lyrics.alternatives));
  assert.equal(TimelineState.lines(state)[0].words, "Original (旧译文)");
  assert.deepEqual(TimelineState.viewLine(state, 1), {
    startTimeMs: "900",
    endTimeMs: "1800",
    words: "Second line",
    base: "Second line",
    translation: "",
    syllables: [],
    allowEmptyWords: false,
  });

  TimelineState.applyLine(state, 1, { base: "Changed original", translation: "修改后的译文" });
  const payload = TimelineState.toSavePayload(state);
  assert.equal(payload.lyrics.lyrics.lines[1].words, "Changed original(修改后的译文)");
  assert.deepEqual(payload.lyrics.lyrics.alternatives, expectedAlternatives);
});

test("timeline draft round-trip never migrates parenthetical translations to alternatives", () => {
  const document = timelineFixture();
  delete document.lyrics.lyrics.alternatives;
  const state = TimelineState.createState(document);
  assert.equal(TimelineState.VERSION, 2);
  assert.equal(TimelineState.lines(state)[0].words, "Original (旧译文)");
  assert.equal(TimelineState.viewLine(state, 0).translation, "旧译文");
  assert.equal(state.document.lyrics.lyrics.alternatives, undefined);
  const restored = TimelineState.createState(document);
  TimelineState.restoreState(restored, TimelineState.serializeState(state));
  assert.equal(TimelineState.lines(restored)[0].words, "Original (旧译文)");
  assert.equal(restored.document.lyrics.lyrics.alternatives, undefined);
});

test("native timeline draft validation accepts the current web draft version", () => {
  const controller = readSource("LyricsTimelineEditorViewController.swift");
  const match = controller.match(/private static let draftVersion = (\d+)/);
  assert.ok(match, "the native draft contract must expose one explicit version");
  assert.equal(Number(match[1]), TimelineState.VERSION);
  assert.match(controller, /\(object\["version"\] as\? NSNumber\)\?\.intValue == Self\.draftVersion/);
});

test("native timeline bridge serves model, translation, validation, and awaited CAS commands", () => {
  const controller = readSource("LyricsTimelineEditorViewController.swift");
  const configuration = readSource("LyricsShareEditorConfiguration.swift");

  for (const command of ["models", "translate", "validateCanonical", "save"]) {
    assert.match(controller, new RegExp(`case "${command}"`));
  }
  assert.match(controller, /let requestID = message\["requestId"\] as\? String/);
  assert.match(controller, /sendCommandResult\(requestID:/);
  assert.match(controller, /X-MITM-Lyrics-Token/);
  assert.match(controller, /upstreamStatus/);
  assert.match(controller, /missingFields/);
  assert.match(configuration, /translationModelsEndpointURL/);
  assert.match(configuration, /shareEditorTranslateEndpointURL/);
  assert.match(configuration, /shareEditorValidateEndpointURL/);
});

test("bundled share editor hides translations as persisted presentation state only", () => {
  const original = {
    source: "github",
    hash: HASH,
    track: { trackId: "track-1", title: "Title", artist: "Artist", album: "Album" },
    lyrics: { lines: [{ words: "Original(译文)" }], alternatives: [] },
    selectedLineIndices: [0],
  };
  const state = ShareState.reduceEditorState(ShareState.createEditorState(original), { type: "toggleTranslations" });
  const layout = ShareRenderer.createLyricsLayout({
    font: "",
    measureText: (value) => ({ width: String(value).length * 6.5 }),
  }, state, ShareRenderer.resolveTemplate("skeleton"), {});

  assert.equal(state.showTranslations, false);
  assert.deepEqual(layout.groups[0].translationRows, []);
  assert.equal(JSON.parse(ShareState.serializeState(state)).document.lyrics.lines[0].words, "Original(译文)");
  assert.equal(ShareState.restoreState(ShareState.serializeState(state)).showTranslations, false);
});

test("native share bootstrap passes position only for the matching active track", () => {
  const controller = readSource("LyricsShareEditorViewController.swift");
  assert.match(controller, /let snapshot = LyricsTimelinePlayerBridge\.shared\.snapshot\(\)/);
  assert.match(controller, /snapshot\.trackId == activeTrack\?\.trackId/);
  assert.match(controller, /let matchingPositionMs: Int\?/);
  assert.match(controller, /const loadOptions = \\\(loadOptions\);/);
  assert.doesNotMatch(controller, /const loadOptions = \(loadOptions\);/);
  assert.match(controller, /window\.ShareEditor\.loadDocument\(editorDocument, loadOptions\)/);
});

test("native project restore accepts legacy v1 and current v2 share projects", () => {
  const controller = readSource("LyricsShareEditorViewController.swift");
  assert.match(controller, /supportedProjectVersions:\s*Set<Int>\s*=\s*\[1, 2\]/);
  assert.match(controller, /Self\.supportedProjectVersions\.contains\(version\)/);
});

test("iOS keeps its poster geometry while shared editor behavior stays mirrored", () => {
  const renderer = fs.readFileSync(path.join(SHARE_BUNDLE, "renderer.js"), "utf8");
  const app = fs.readFileSync(path.join(SHARE_BUNDLE, "app.js"), "utf8");
  const state = fs.readFileSync(path.join(SHARE_BUNDLE, "editor-state.js"), "utf8");
  const html = fs.readFileSync(path.join(SHARE_BUNDLE, "index.html"), "utf8");
  assert.match(renderer, /poster:\s*Object\.freeze\(\{[\s\S]*lyricsInset:\s*30,[\s\S]*lyricMaxSize:\s*24,/);
  assert.match(renderer, /state\.showTranslations === false/);
  assert.match(app, /pendingState \|\| pendingDocument \|\| LOADING_DOCUMENT/);
  assert.match(app, /this\.loadDocument\(payload, \{ positionMs: bootstrap\.positionMs \}\)/);
  assert.match(state, /function defaultSelectedIndices\(/);
  assert.match(state, /showTranslations: state\.showTranslations/);
  assert.match(html, /id="translation-toggle"[^>]*aria-pressed="true"/);
});
