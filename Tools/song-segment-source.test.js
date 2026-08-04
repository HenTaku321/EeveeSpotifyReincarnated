"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const skipper = fs.readFileSync(path.join(root, "Sources/EeveeSpotify/ShareEditor/SongSegmentSkipper.swift"), "utf8");
const bridge = fs.readFileSync(path.join(root, "Sources/EeveeSpotify/ShareEditor/LyricsTimelinePlayerBridge.swift"), "utf8");
const eeveeHooks = fs.readFileSync(path.join(root, "Sources/EeveeSpotify/SponsorBlock/SponsorBlockHooks.x.swift"), "utf8");
const standaloneHooks = fs.readFileSync(path.join(root, "Sources/MITMLyricsStudio/StandalonePlayerHooks.x.swift"), "utf8");
const standaloneMakefile = fs.readFileSync(path.join(root, "Makefile.standalone"), "utf8");

test("playback event identity is strict to the current music state", () => {
  assert.match(bridge, /struct LyricsPlaybackEvent/);
  assert.match(bridge, /func capture\(player: AnyObject, state: AnyObject\) -> LyricsPlaybackEvent/);
  assert.match(bridge, /resolveStateMusicTrackID\(state:/);
  assert.match(bridge, /spotify:track:/);
  assert.doesNotMatch(bridge.match(/private func resolveStateMusicTrackID[\s\S]*?\n    }/)?.[0] || "", /statefulPlayer/);
});

test("both Eevee and standalone observers feed the same independent song skipper", () => {
  for (const source of [eeveeHooks, standaloneHooks]) {
    assert.match(source, /let event = LyricsTimelinePlayerBridge\.shared\.capture/);
    assert.match(source, /SongSegmentSkipper\.shared\.process\(event: event, player: player\)/);
  }
  assert.match(standaloneMakefile, /find Sources\/EeveeSpotify\/ShareEditor -name '\*\.swift'/);
});

test("song skipper fetches versioned rules and uses generation plus expected-track seek", () => {
  assert.match(skipper, /struct SongSegmentRulesDocument: Decodable/);
  assert.match(skipper, /revision: Int/);
  assert.match(skipper, /fetchGeneration/);
  assert.match(skipper, /url: configuration\.segmentsEndpointURL/);
  assert.doesNotMatch(skipper, /deletingLastPathComponent\(\).*segments/);
  assert.match(skipper, /X-MITM-Lyrics-Token/);
  assert.match(
    skipper,
    /LyricsTimelinePlayerBridge\.shared\.seek\(\s*positionMs: action\.positionMs,\s*expectedTrackID: action\.trackId\s*\)/,
  );
  assert.match(skipper, /DispatchSource\.makeTimerSource/);
  assert.match(skipper, /repeating: \.milliseconds\(250\)/);
});

test("polling reads the captured stateful player instead of extrapolating observer time", () => {
  const poll = skipper.slice(
    skipper.indexOf("private func poll()"),
    skipper.indexOf("private func fetchRules"),
  );
  assert.match(poll, /LyricsTimelinePlayerBridge\.shared\.snapshot\(\)/);
  assert.match(poll, /snapshot\.positionMs/);
  assert.match(poll, /snapshot\.isPlaying/);
  assert.doesNotMatch(poll, /estimated|latestEventAtMs|playbackSpeed/);
  assert.doesNotMatch(bridge, /playbackSpeed/);
});

test("state machine explicitly handles manual jumps, pending seek, cooldown, and disabled rules", () => {
  assert.match(skipper, /manualSeekThresholdMs/);
  assert.match(skipper, /pendingSeek/);
  assert.match(skipper, /cooldownUntilMs/);
  assert.match(skipper, /guard rule\.enabled/);
  assert.match(skipper, /bypassed\.insert/);
  assert.match(skipper, /consumed\.insert/);
});

test("song skipper owns a cross-dylib player marker instead of inheriting SponsorBlock", () => {
  assert.match(skipper, /objc_getAssociatedObject/);
  assert.match(skipper, /objc_setAssociatedObject/);
  assert.doesNotMatch(skipper, /SponsorBlockSkipper|spotify:episode:|SponsorBlockAPI/);
});

test("a stale rules response cannot clear the active track fetch", () => {
  const completion = skipper.slice(
    skipper.indexOf("URLSession.shared.dataTask"),
    skipper.indexOf("}.resume()", skipper.indexOf("URLSession.shared.dataTask")),
  );
  const generationGuard = completion.indexOf("generation == self.fetchGeneration");
  const clearInFlight = completion.indexOf("self.fetchInFlight = false");
  assert.ok(generationGuard >= 0, "completion must reject stale generations");
  assert.ok(clearInFlight > generationGuard, "only the active generation may clear fetchInFlight");
});

test("failed rules fetches are rate limited instead of retried every poll", () => {
  const fetchMethod = skipper.slice(
    skipper.indexOf("private func fetchRules"),
    skipper.indexOf("private func clearCurrentTrack"),
  );
  const requestStart = fetchMethod.indexOf("lastFetchAtMs = monotonicMs()");
  const dataTask = fetchMethod.indexOf("URLSession.shared.dataTask");
  assert.ok(requestStart >= 0 && requestStart < dataTask, "fetch start must advance the retry clock");
});
