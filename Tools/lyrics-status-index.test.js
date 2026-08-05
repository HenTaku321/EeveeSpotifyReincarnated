"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("standalone and coexistence share the native canonical lyrics status cache", () => {
  const source = read("Sources/EeveeSpotify/ShareEditor/LyricsStatusIndexStore.swift");
  const configuration = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorConfiguration.swift");
  const standalone = read("Sources/MITMLyricsStudio/StandaloneBootstrap.x.swift");
  const coexistence = read("Sources/EeveeSpotify/Tweak.x.swift");

  assert.match(source, /final class LyricsStatusIndexStore/);
  assert.match(source, /case lyrics/);
  assert.match(source, /case instrumental/);
  assert.match(source, /case noLyrics = "no-lyrics"/);
  assert.match(source, /utf8\.count == 22/);
  assert.match(source, /lyrics-status-index-v1\.json/);
	assert.match(source, /\.applicationSupportDirectory/);
	assert.doesNotMatch(source, /\.documentDirectory/);
  assert.match(source, /If-None-Match/);
  assert.match(source, /http\.statusCode == 304/);
  assert.match(source, /document\.revision < currentDocument\.revision/);
  assert.match(source, /UIApplicationDidBecomeActiveNotification/);
  assert.match(configuration, /lyricsStatusIndexEndpointURL/);
  assert.match(standalone, /LyricsStatusIndexStore\.shared\.start\(\)/);
  assert.match(coexistence, /LyricsStatusIndexStore\.shared\.start\(\)/);
});

test("confirmed editor surfaces show canonical status and refresh after a successful save", () => {
  const share = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorViewController.swift");
  const timeline = read("Sources/EeveeSpotify/ShareEditor/LyricsTimelineEditorViewController.swift");
  const finishSave = timeline.slice(
    timeline.indexOf("private func finishSave"),
    timeline.indexOf("private func perform", timeline.indexOf("private func finishSave")),
  );

  assert.match(share, /updateLyricsStatusPrompt/);
  assert.match(share, /navigationItem\.prompt/);
  assert.match(timeline, /updateLyricsStatusPrompt/);
  assert.match(timeline, /navigationItem\.prompt/);
  assert.match(finishSave, /LyricsStatusIndexStore\.shared\.refresh\(force: true\)/);
});
