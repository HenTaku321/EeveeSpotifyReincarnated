"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

test("standalone target links native Apple motion playback", () => {
  const makefile = read("Makefile.standalone");
  const playerView = read("Sources/MITMLyricsStudio/MotionArtworkPlayerView.swift");

  assert.match(makefile, /MITMLyricsStudio_FRAMEWORKS\s*=.*\bAVFoundation\b/);
  assert.match(playerView, /import AVFoundation/);
  assert.match(playerView, /AVQueuePlayer/);
  assert.match(playerView, /AVPlayerLooper/);
  assert.match(playerView, /AVPlayerLayer/);
  assert.match(playerView, /videoGravity\s*=\s*\.resizeAspectFill/);
  assert.match(playerView, /isMuted\s*=\s*true/);
  assert.match(playerView, /func stop\(\)/);
});

test("resolver transport is authenticated bounded and Apple-host allowlisted", () => {
  const configuration = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorConfiguration.swift");
  const client = read("Sources/MITMLyricsStudio/MotionArtworkClient.swift");

  assert.match(configuration, /appleMotionArtworkEndpointPath\s*=\s*"v1\/apple-motion-artwork"/);
  assert.match(configuration, /let appleMotionArtworkEndpointURL: URL/);
  assert.match(client, /URLQueryItem\(name:\s*"artist"/);
  assert.match(client, /URLQueryItem\(name:\s*"album"/);
  assert.match(client, /X-MITM-Lyrics-Token/);
  assert.match(client, /maximumBytes:\s*128\s*\*\s*1024/);
  assert.match(client, /url\.host\?\.lowercased\(\)\s*==\s*"mvod\.itunes\.apple\.com"/);
  assert.match(client, /pathExtension\.lowercased\(\)\s*==\s*expectedExtension/);
  assert.match(client, /payload\.videoUrl/);
  assert.match(client, /payload\.hlsUrl/);
  assert.match(client, /videoURL\s*\?\?\s*hlsURL/);
});

test("preferences support a true zero-request global disable and bounded album exclusions", () => {
  const preferences = read("Sources/MITMLyricsStudio/MotionArtworkPreferences.swift");
  const identity = read("Sources/MITMLyricsStudio/MotionArtworkIdentity.swift");
  const coordinator = read("Sources/MITMLyricsStudio/MotionArtworkCoordinator.swift");

  assert.match(preferences, /globalEnabled/);
  assert.match(preferences, /maximumDisabledAlbums\s*=\s*512/);
  assert.match(identity, /spotifyAlbumID/);
  assert.match(identity, /"id:\\?\(spotifyAlbumID\)"/);
  assert.match(identity, /return\s+"name:"\s*\+/);
  assert.match(identity, /var preferenceToken:\s*String\s*\{\s*key\s*\}/s);
  assert.match(coordinator, /guard preferences\.globalEnabled else/);
  assert.match(coordinator, /client\.resolve/);
  assert.ok(
    coordinator.indexOf("guard preferences.globalEnabled else") < coordinator.indexOf("client.resolve"),
    "global enable gate must execute before resolver network work",
  );
});

test("surface coordinator rejects stale async results and releases reused hosts", () => {
  const coordinator = read("Sources/MITMLyricsStudio/MotionArtworkCoordinator.swift");

  assert.match(coordinator, /objc_getAssociatedObject/);
  assert.match(coordinator, /objc_setAssociatedObject/);
  assert.match(coordinator, /requestID/);
  assert.match(coordinator, /identity\.key/);
  assert.match(coordinator, /attachment\.requestID == requestID/);
  assert.match(coordinator, /attachment\.identityKey == identity\.key/);
  assert.match(coordinator, /func remove\(from host:/);
  assert.match(coordinator, /attachment\(for:\s*host\)\?\.stop\(\)/);
  assert.match(coordinator, /playerView\?\.removeFromSuperview\(\)/);
});

test("standalone bootstrap does not activate unverified motion artwork hooks", () => {
  const bootstrap = read("Sources/MITMLyricsStudio/StandaloneBootstrap.x.swift");
  const filter = read("MITMLyricsStudio.plist");

  assert.doesNotMatch(bootstrap, /activateMotionArtwork[A-Za-z0-9_]*Hooks\(\)/);
  assert.match(filter, /com\.spotify\.client/);
});

test("album-page diagnostics are compile-time gated and read-only", () => {
  const makefile = read("Makefile.standalone");
  const workflow = read(".github/workflows/build-standalone-lyrics-studio.yml");
  const bootstrap = read("Sources/MITMLyricsStudio/StandaloneBootstrap.x.swift");
  const diagnostics = read("Sources/MITMLyricsStudio/MotionArtworkAlbumPageDiagnostics.swift");

  assert.match(makefile, /ifeq\s*\(\$\(MITM_MOTION_ARTWORK_DIAGNOSTICS\),1\)/);
  assert.match(bootstrap, /#if MITM_MOTION_ARTWORK_DIAGNOSTICS/);
  assert.match(diagnostics, /^#if MITM_MOTION_ARTWORK_DIAGNOSTICS/m);
  assert.match(workflow, /production package unexpectedly contains motion artwork diagnostics/);
  assert.match(diagnostics, /\[MITMMotionProbe\]/);
  assert.match(diagnostics, /UIImageView/);
  assert.match(diagnostics, /class_copyMethodList/);
  assert.doesNotMatch(diagnostics, /method_exchangeImplementations|class_addMethod|class_replaceMethod/);
  assert.doesNotMatch(diagnostics, /addSubview|removeFromSuperview|AVPlayer/);
});

test("album-page motion artwork hook is blocked pending runtime evidence", (t) => {
  const hookPath = "Sources/MITMLyricsStudio/MotionArtworkAlbumPageHooks.x.swift";
  if (!exists(hookPath)) {
    t.skip("blocked: no runtime-validated Spotify album-page class/selector evidence");
    return;
  }

  const hook = read(hookPath);
  assert.match(hook, /func activateMotionArtworkAlbumPageHooks\(\) -> Bool/);
  assert.doesNotMatch(hook, /Eevee/);
});
