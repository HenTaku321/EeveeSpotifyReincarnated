"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ShareState = require("../layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor/editor-state.js");
const TimelineState = require("../layout/Library/Application Support/EeveeSpotify.bundle/TimelineEditor/editor-state.js");

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const HASH = "0123456789abcdef".repeat(4);

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
