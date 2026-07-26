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

test("standalone target owns unique package and resource identities", () => {
  assert.equal(exists("Makefile.standalone"), true);
  assert.equal(exists("MITMLyricsStudio.plist"), true);
  assert.equal(exists("control.standalone"), true);

  const makefile = read("Makefile.standalone");
  assert.match(makefile, /TWEAK_NAME\s*=\s*MITMLyricsStudio/);
  assert.match(makefile, /MITM_LYRICS_STANDALONE/);
  assert.match(makefile, /MITMLyricsStudio\.bundle/);
  assert.doesNotMatch(makefile, /EeveeSwiftProtobuf/);

  const filter = read("MITMLyricsStudio.plist");
  assert.match(filter, /com\.spotify\.client/);
  assert.doesNotMatch(filter, /EeveeSpotify/);

  const control = read("control.standalone");
  assert.match(control, /^Package: com\.mitmlyrics\.studio$/m);
  assert.match(control, /^Name: MITM Lyrics Studio$/m);
});

test("standalone target owns runtime, player observation and C invocation helpers", () => {
  const compatibility = read("Sources/MITMLyricsStudio/StandaloneCompatibility.swift");
  const hooks = read("Sources/MITMLyricsStudio/StandalonePlayerHooks.x.swift");
  const bootstrap = read("Sources/MITMLyricsStudio/StandaloneBootstrap.swift");
  const cBridge = read("Sources/MITMLyricsStudioC/Tweak.m");
  const moduleMap = read("Sources/MITMLyricsStudioC/include/module.modulemap");

  assert.match(compatibility, /final class BundleHelper/);
  assert.match(compatibility, /MITMLyricsStudio\.bundle/);
  assert.match(compatibility, /static var container: UserDefaults = \.standard/);
  assert.match(compatibility, /func writeDebugLog/);
  assert.match(compatibility, /struct WindowHelper/);
  assert.match(hooks, /SPTPlayerServiceImplementation/);
  assert.match(hooks, /provideStatefulPlayerWithFeatureIdentifier:/);
  assert.match(hooks, /LyricsTimelinePlayerBridge\.shared\.capture/);
  assert.match(bootstrap, /activateStandalonePlayerHooks\(\)/);
  assert.match(bootstrap, /activateLyricsEditorEntries\(\)/);
  assert.match(cBridge, /EeveeSBInvokeSeekDouble/);
  assert.match(cBridge, /EeveeInvokeBool/);
  assert.match(moduleMap, /module MITMLyricsStudioC/);
});

test("standalone workflow emits a TrollFools archive without Eevee payloads", () => {
  const workflow = read(".github/workflows/build-standalone-lyrics-studio.yml");
  assert.match(workflow, /make -f Makefile\.standalone/);
  assert.match(workflow, /MITMLyricsStudio\.dylib/);
  assert.match(workflow, /MITMLyricsStudio\.bundle/);
  assert.match(workflow, /Orion\.framework/);
  assert.match(workflow, /MITMLyricsStudio-trollfools\.zip/);
  assert.match(workflow, /verify-standalone-editor\.sh/);
  assert.doesNotMatch(workflow, /EeveeSpotify\.dylib/);
  assert.match(workflow, /if any\("Eevee" in name for name in names\)/);
  assert.doesNotMatch(workflow, /EeveeSwiftProtobuf/);
});

test("shared player bridge selects the standalone C module at compile time", () => {
  const playerBridge = read("Sources/EeveeSpotify/ShareEditor/LyricsTimelinePlayerBridge.swift");
  assert.match(playerBridge, /#if MITM_LYRICS_STANDALONE/);
  assert.match(playerBridge, /import MITMLyricsStudioC/);
  assert.match(playerBridge, /#else\s+import EeveeSpotifyC\s+#endif/s);
});

test("standalone editors expose module-owned service configuration", () => {
  const configuration = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorConfiguration.swift");
  const launcher = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorLauncher.swift");
  const shareController = read("Sources/EeveeSpotify/ShareEditor/LyricsShareEditorViewController.swift");
  const timelineController = read("Sources/EeveeSpotify/ShareEditor/LyricsTimelineEditorViewController.swift");

  assert.match(configuration, /static func validated\(serverURL: String, token rawToken: String\)/);
  assert.match(launcher, /enum LyricsEditorServiceConfigurationPresenter/);
  assert.match(launcher, /UserDefaults\.shareEditorServerURL =/);
  assert.match(launcher, /UserDefaults\.shareEditorToken =/);
  assert.match(shareController, /#selector\(configureLyricsService\)/);
  assert.match(timelineController, /#selector\(configureLyricsService\)/);
  assert.doesNotMatch(shareController, /包含 EeveeSpotify\.bundle/);
  assert.doesNotMatch(timelineController, /包含 EeveeSpotify\.bundle/);
});
