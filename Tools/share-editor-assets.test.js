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
        alternatives: [{ language: "zh-CN", contentType: "translation", lines: ["旧译文", "第二行"] }],
      },
    },
  };
}

test("timeline keeps originals and translations in separate native fields", () => {
  const state = TimelineState.createState(timelineFixture());
  assert.equal(TimelineState.lines(state)[0].words, "Original");
  assert.deepEqual(TimelineState.viewLine(state, 1), {
    startTimeMs: "900",
    endTimeMs: "1800",
    words: "Second line",
    base: "Second line",
    translation: "第二行",
    syllables: [],
  });

  TimelineState.applyLine(state, 1, { base: "Changed original", translation: "修改后的译文" });
  const payload = TimelineState.toSavePayload(state);
  assert.equal(payload.lyrics.lyrics.lines[1].words, "Changed original");
  assert.equal(payload.lyrics.lyrics.alternatives[0].lines[1], "修改后的译文");
});

test("timeline migrates legacy parenthetical translations to alternatives", () => {
  const document = timelineFixture();
  delete document.lyrics.lyrics.alternatives;
  const state = TimelineState.createState(document);
  assert.equal(TimelineState.lines(state)[0].words, "Original");
  assert.equal(TimelineState.viewLine(state, 0).translation, "旧译文");
  assert.equal(state.document.lyrics.lyrics.alternatives[0].lines[0], "旧译文");
});
