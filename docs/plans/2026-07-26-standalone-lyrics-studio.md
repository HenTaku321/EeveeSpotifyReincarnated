# Standalone Lyrics Studio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a standalone iOS MITM Lyrics editor package, add current-track share/timeline editing to Spicetify, and make the browser editor load Lyrics Repo documents without manual track identity entry.

**Architecture:** Keep `share-editor-work` at `f5f2eba` as the Eevee-hosted rollback. Build `MITMLyricsStudio` from the proven editor Swift/assets plus a module-owned compatibility/runtime layer; desktop and browser reuse the existing document/state contracts rather than fork them. Each platform adapts its current-track source at the boundary and passes a validated editor document inward.

**Tech Stack:** Swift/Orion/Theos, Objective-C runtime helpers, WKWebView, TrollFools packaging, vanilla JavaScript/Canvas, Spicetify Custom Apps, Go embedded web assets, Node tests, GitHub Actions macOS/Xcode.

---

### Task 1: Lock the dual-package boundary

**Files:**
- Create: `Tools/verify-standalone-editor.sh`
- Create: `Tools/standalone-package.test.js`
- Create: `MITMLyricsStudio.plist`
- Create: `control.standalone`

1. Write a failing package test requiring unique dylib/bundle names, a Spotify bundle filter, and no Eevee artifacts in the standalone archive.
2. Run `node Tools/standalone-package.test.js`; expect failure because the standalone manifest does not exist.
3. Add the minimal manifests and verifier.
4. Re-run the package test and existing `./Tools/verify-share-editor.sh`; expect both to pass.

### Task 2: Add the standalone native compatibility layer

**Files:**
- Create: `Sources/MITMLyricsStudio/StandaloneCompatibility.swift`
- Create: `Sources/MITMLyricsStudio/StandalonePlayerHooks.x.swift`
- Create: `Sources/MITMLyricsStudio/StandaloneBootstrap.swift`
- Create: `Sources/MITMLyricsStudioC/include/Tweak.h`
- Create: `Sources/MITMLyricsStudioC/include/module.modulemap`
- Create: `Sources/MITMLyricsStudioC/Tweak.m`
- Modify: `Sources/EeveeSpotify/ShareEditor/LyricsTimelinePlayerBridge.swift`

1. Extend the static test to require module-owned bundle lookup, preferences, logging, window lookup, track capture and runtime invocation helpers.
2. Run the test and verify it fails on the missing compatibility symbols.
3. Implement only the compatibility APIs consumed by the proven editor files; conditionally import `MITMLyricsStudioC` for standalone builds.
4. Add class/selector-gated player observation and entry hook activation without reading Eevee globals.
5. Run static verification and the Eevee regression verifier.

### Task 3: Build and package MITMLyricsStudio

**Files:**
- Create: `Makefile.standalone`
- Create: `Package.standalone.swift`
- Create: `layout-standalone/Library/Application Support/MITMLyricsStudio.bundle/.keep`
- Create: `.github/workflows/build-standalone-lyrics-studio.yml`

1. Add failing assertions for the selected Swift source list, standalone compile flag, resource staging and TrollFools ZIP contents.
2. Implement a dedicated Theos target that compiles the shared editor files with `-D MITM_LYRICS_STANDALONE`, excludes Eevee Premium/SponsorBlock code and excludes `EeveeSwiftProtobuf.framework`.
3. Stage ShareEditor/TimelineEditor resources under `MITMLyricsStudio.bundle` and package the dylib, bundle and Orion runtime into one deterministic ZIP.
4. Run both local verifiers.

### Task 4: Add Spicetify editor launch and current-track adaptation

**Files:**
- Create: `/home/hentaku/mcp-sandbox/client/spicetify-ext/mitm-lyrics-app/editor-source.js`
- Create: `/home/hentaku/mcp-sandbox/client/spicetify-ext/mitm-lyrics-app/editor-page.js`
- Modify: `/home/hentaku/mcp-sandbox/client/spicetify-ext/mitm-lyrics-app/index.js`
- Modify: `/home/hentaku/mcp-sandbox/client/spicetify-ext/mitm-lyrics-app/style.css`
- Modify: `/home/hentaku/mcp-sandbox/client/spicetify-ext/tests/mitm-lyrics-repository-app.test.js`

1. Write tests for `Spicetify.Player.data` identity normalization, current artwork extraction, repository load, share/timeline mode switching and error fallback.
2. Run the focused Node test and observe missing-module failures.
3. Implement the current-track adapter and editor page using `MITMRepositoryApi`; fetch artwork with byte/MIME/size limits and populate only the card cover slot.
4. Run focused and full `npm test`.

### Task 5: Integrate Lyrics Repo into the browser editors

**Files:**
- Create: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/static/repository-source.js`
- Modify: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/static/index.html`
- Modify: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/static/app.js`
- Modify: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/static/style.css`
- Modify: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/tests/app.test.js`
- Modify: `/home/hentaku/go/src/spotify-lyrics-translate/cs/web/shareeditor/embed_test.go`

1. Write tests for repository list/file envelopes, path safety, search filtering, track identity recovery and `loadDocument` handoff.
2. Run the focused Node/Go tests and observe failures.
3. Implement a repository browser as a source adapter; keep manual metadata in an advanced fallback section.
4. Reuse existing repository authentication/config and preserve the current editor state after load.
5. Run share editor tests and `go test ./...`.

### Task 6: Verify, deploy web changes and close the Actions loop

**Files:**
- Modify as required by test, deployment or Xcode diagnostics.

1. Build `cs/cmd/server`, deploy it to the configured VPS, restart the service and verify health plus `/share-editor` assets.
2. Commit and push `standalone-editor-work` without modifying the `share-editor-work` rollback branch.
3. Trigger `build-standalone-lyrics-studio.yml` with `gh workflow run --ref standalone-editor-work`.
4. Inspect failed job logs, add the smallest tested correction, push and repeat until GitHub Actions succeeds.
5. Download the artifact and run the archive verifier against its exact contents.
