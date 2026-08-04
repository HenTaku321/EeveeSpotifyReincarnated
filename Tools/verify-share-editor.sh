#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bundle_dir="$repo_dir/layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor"
timeline_bundle_dir="$repo_dir/layout/Library/Application Support/EeveeSpotify.bundle/TimelineEditor"
source_dir="$repo_dir/Sources/EeveeSpotify/ShareEditor"
workflow="$repo_dir/.github/workflows/build-share-editor.yml"
splice_tool="$repo_dir/Tools/splice-deb-into-ipa.sh"
readme="$repo_dir/README.md"

test -f "$workflow"
test -x "$splice_tool"
sh -n "$splice_tool"
grep -Fq 'refusing to overwrite the input IPA' "$splice_tool"
grep -Fq 'refusing to overwrite the input .deb' "$splice_tool"
grep -Fq 'output_stage=$(mktemp -d "$out_directory/.eevee-ipa-output.XXXXXXXX")' "$splice_tool"
grep -Fq 'mv -f -- "$staged_ipa" "$out_ipa"' "$splice_tool"
if grep -Fq 'rm -f "$out_ipa"' "$splice_tool"; then
    echo "splice cleanup must not delete a pre-existing output IPA" >&2
    exit 1
fi
grep -Fq 'refusing IPA containing symbolic links' "$splice_tool"
grep -Fq 'refusing .deb payload containing symbolic links' "$splice_tool"
grep -Fq 'ldid -e "$main"' "$splice_tool"
grep -Fq 'ldid -S"$work/main.entitlements.plist" "$main"' "$splice_tool"
grep -Fq 'main executable entitlements are empty' "$splice_tool"
grep -Fq 'EeveeSpotify\.bundle/TimelineEditor/index\.html$' "$splice_tool"
grep -Fq 'runs-on: macos-15' "$workflow"
grep -Fq 'xcode-version: "16.2.0"' "$workflow"
grep -Fq 'THEOS_PACKAGE_SCHEME=rootless make package FINALPACKAGE=1' "$workflow"
grep -Fq 'actions/upload-artifact@v4' "$workflow"
grep -Fq 'brew install make dpkg ldid zip' "$workflow"
grep -Fq 'brew install dpkg ldid unzip zip' "$workflow"
grep -Fq 'ipa_url' "$workflow"
grep -Fq 'ipa_sha256' "$workflow"
grep -Fq 'parsed.scheme != "https"' "$workflow"
grep -Fq -- "--proto '=https' --proto-redir '=https'" "$workflow"
grep -Fq 'printf '\''ref=%s\n'\'' "$BRANCH_NAME"' "$workflow"
grep -Fq 'SAFE_VERSION="$(printf '\''%.64s'\'' "$SAFE_VERSION")"' "$workflow"
grep -Fq 'TROLLFOOLS_ROOT="$RUNNER_TEMP/trollfools-root"' "$workflow"
grep -Fq 'Outputs/TROLLFOOLS/EeveeSpotify-share-editor-trollfools.zip' "$workflow"
grep -Fq 'expected_top_level = {' "$workflow"
grep -Fq 'if top_level != expected_top_level:' "$workflow"
grep -Fq 'EeveeSwiftProtobuf.framework/EeveeSwiftProtobuf' "$workflow"
grep -Fq 'Orion.framework/Orion' "$workflow"
grep -Fq '"Orion.framework",' "$workflow"
grep -Fq 'https://github.com/theos/orion/releases/download/1.0.2/Orion_1.0.2.zip' "$workflow"
grep -Fq '67ea96da8983a792bc9e5549472c2e597b84024c66bce888ce19e7940e413e55' "$workflow"
grep -Fq 'dev.theos.orion14_1.0.2_iphoneos-arm64.deb' "$workflow"
grep -Fq '5389d02f0f2e74d3cfbeca88739a85ba81f36a0294439559c89d7a76e6bee21e' "$workflow"
if grep -Fq 'make -C "$THEOS/vendor/orion"' "$workflow"; then
    echo "workflow must use the pinned official Orion runtime instead of rebuilding it" >&2
    exit 1
fi
grep -Fq 'EeveeSpotify.bundle/ShareEditor/index.html' "$workflow"
grep -Fq 'EeveeSpotify.bundle/TimelineEditor/index.html' "$workflow"
grep -Fq 'name: eevee-share-editor-trollfools-zip' "$workflow"
grep -Fq 'path: Outputs/TROLLFOOLS/EeveeSpotify-share-editor-trollfools.zip' "$workflow"
grep -Fq 'TrollFools v4.3' "$readme"
grep -Fq '`eevee-share-editor-trollfools-zip`' "$readme"
grep -Fq 'extract that outer artifact archive first' "$readme"
grep -Fq 'contained `EeveeSpotify-share-editor-trollfools.zip` into TrollFools' "$readme"

splice_preserve_dir=$(mktemp -d "${TMPDIR:-/tmp}/eevee-splice-preserve.XXXXXXXX")
cleanup_splice_preserve_test() {
    rm -rf -- "$splice_preserve_dir"
}
trap cleanup_splice_preserve_test EXIT HUP INT TERM
printf 'invalid ipa\n' > "$splice_preserve_dir/base.ipa"
printf 'invalid deb\n' > "$splice_preserve_dir/package.deb"
printf 'existing output must survive\n' > "$splice_preserve_dir/output.ipa"
cp "$splice_preserve_dir/output.ipa" "$splice_preserve_dir/expected.ipa"
if "$splice_tool" \
    "$splice_preserve_dir/base.ipa" \
    "$splice_preserve_dir/package.deb" \
    "$splice_preserve_dir/output.ipa" \
    >"$splice_preserve_dir/stdout.log" 2>"$splice_preserve_dir/stderr.log"; then
    echo "invalid splice fixture unexpectedly succeeded" >&2
    exit 1
fi
cmp "$splice_preserve_dir/expected.ipa" "$splice_preserve_dir/output.ipa"
cleanup_splice_preserve_test
trap - EXIT HUP INT TERM

if grep -E '\|[[:space:]]*(head|grep[[:space:]]+-q)\b' "$workflow" >/dev/null; then
    echo "workflow pipelines must consume complete output under pipefail" >&2
    exit 1
fi

if grep -Fq 'printf '\''ref=%s\n'\'' "${{ inputs.ref }}"' "$workflow"; then
    echo "workflow inputs must enter shell scripts through env, not expression interpolation" >&2
    exit 1
fi

if git -C "$repo_dir" ls-files '*.ipa' | grep . >/dev/null; then
    echo "copyrighted IPA must not be tracked in the Eevee source repository" >&2
    exit 1
fi

for file in index.html app.js editor-state.js renderer.js style.css icons.js repository-source.js tokens.css; do
    test -f "$bundle_dir/$file"
done

for file in index.html app.js editor-state.js style.css browser-host.js icons.js tokens.css; do
    test -f "$timeline_bundle_dir/$file"
done

node --check "$bundle_dir/app.js"
node --check "$bundle_dir/editor-state.js"
node --check "$bundle_dir/renderer.js"
node --check "$timeline_bundle_dir/app.js"
node --check "$timeline_bundle_dir/editor-state.js"
node --check "$timeline_bundle_dir/browser-host.js"
node --test "$repo_dir/Tools/share-editor-assets.test.js"
node --test "$repo_dir/Tools/segment-editor-bridge.test.js"

grep -Fq 'name: "shareEditor"' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'X-MITM-Lyrics-Token' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'import Photos' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'requestAuthorization(for: .addOnly)' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'PHAssetCreationRequest.forAsset()' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'addResource(with: .photo, data: png.data' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'PNG 已保存到系统图库。' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'appendingPathComponent("Exports", isDirectory: true)' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'EeveeSpotify_FRAMEWORKS = WebKit Photos' "$repo_dir/Makefile"
grep -Fq 'Documents/ShareEditor/Projects' "$source_dir/LyricsShareEditorLauncher.swift"
grep -Fq "hide('#load-button')" "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'window.ShareEditor.serializeState();' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'window.ShareEditor.restoreState' "$source_dir/LyricsShareEditorViewController.swift"
if grep -Fq 'project.media.useTrackArtworkAsBackground = true;' "$source_dir/LyricsShareEditorViewController.swift"; then
    echo "track artwork must not be enabled as the share background automatically" >&2
    exit 1
fi
grep -Fq 'maximumBytes = 32 * 1024 * 1024' "$source_dir/LyricsShareEditorBridge.swift"
grep -Fq 'PNG 数据大小超过 32 MiB 限制' "$source_dir/LyricsShareEditorBridge.swift"
grep -Fq 'private static let maximumDocumentBytes = 8 * 1024 * 1024' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'LyricsShareEditorSessionDelegate(maximumBytes: Self.maximumDocumentBytes)' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'MPMediaItemPropertyAlbumTitle' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'MPMediaItemPropertyArtwork' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'artwork.image(at:' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'jpegData(compressionQuality:' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'image_xlarge_url' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'image_large_url' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'static func currentArtworkRemoteURL(matching track:' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'open.spotify.com/oembed' "$source_dir/LyricsShareEditorArtwork.swift"
grep -Fq 'fallbackTrack: track' "$source_dir/LyricsShareEditorArtwork.swift"
grep -Fq 'image-cdn-' "$source_dir/LyricsShareEditorArtwork.swift"
grep -Fq 'CGImageSourceCopyPropertiesAtIndex' "$source_dir/LyricsShareEditorArtwork.swift"
grep -Fq 'maximumArtworkBytes = 2 * 1024 * 1024' "$source_dir/LyricsShareEditorArtwork.swift"
grep -Fq 'scheme != "https", !isLoopback' "$source_dir/LyricsShareEditorConfiguration.swift"
grep -Fq 'completionHandler(nil)' "$source_dir/LyricsShareEditorNetwork.swift"
grep -Fq 'dataTask.cancel()' "$source_dir/LyricsShareEditorNetwork.swift"
grep -Fq 'returnedTrackID.trimmingCharacters' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'LyricsShareEditorTrackResolver.currentArtworkDataURL(matching: track)' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'LyricsShareEditorTrackResolver.currentArtworkRemoteURL(matching: track)' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'artworkLoader.resolve(track: track' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'trackObject["coverUrl"] = artworkDataURL' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'encodedDocument.count > Self.maximumDocumentBytes' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'data.count <= Self.maximumDocumentBytes' "$source_dir/LyricsShareEditorViewController.swift"
if grep -Fq 'LyricsShareEditorPNG.maximumBytes' "$source_dir/LyricsShareEditorViewController.swift"; then
    echo "lyrics document limits must remain independent from the PNG export limit" >&2
    exit 1
fi
grep -Fq 'scriptMessage.frameInfo.isMainFrame' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'removeScriptMessageHandler(forName: "shareEditor")' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'webView.isUserInteractionEnabled = false' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'preserveUnreadableProject' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'case unreadable' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'normalizedTrackID.utf8.count == 22' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'token.utf8.count <= 4096' "$source_dir/LyricsShareEditorConfiguration.swift"
grep -Fq 'name: "timelineEditor"' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'editEndpointURL' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'segmentsEndpointURL' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'case "segmentsGet"' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'case "segmentsPut"' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'error["document"] = document' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'window.LyricsTimelineEditor.serializeState();' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'removeScriptMessageHandler(forName: "timelineEditor")' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'expectedTrackID' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'LyricsTimelinePlayerBridge.shared.capture' "$repo_dir/Sources/EeveeSpotify/SponsorBlock/SponsorBlockHooks.x.swift"
grep -Fq 'func capturedTrackCandidate() -> LyricsShareEditorTrackCandidate?' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'LyricsTimelinePlayerBridge.shared.capturedTrackCandidate()' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'safeRead(trackURI, key: "spt_trackIdentifier")' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'trackURI.map { String(describing: $0) }' "$source_dir/LyricsTimelinePlayerBridge.swift"
if grep -Fq 'observedPlayer' "$source_dir/LyricsTimelinePlayerBridge.swift"; then
    echo "timeline controls must not fall back to a stale observer player" >&2
    exit 1
fi
grep -Fq 'let resolvedDuration = directDuration ?? durationMs' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'private func optionalNumber(' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'let directPlayer = statefulControlPlayer()' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'let isPlaying = directIsPlaying ?? false' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'private func statefulControlPlayer() -> AnyObject?' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'struct StatefulPlayerCaptureGroup: HookGroup' "$repo_dir/Sources/EeveeSpotify/Tweak.x.swift"
grep -Fq 'typealias Group = StatefulPlayerCaptureGroup' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'func activateStatefulPlayerCapture()' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'provideStatefulPlayerWithFeatureIdentifier:' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'method_getNumberOfArguments(method) == 3' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'methodReturnType(method) == "@"' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'methodArgumentType(method, index: 2) == "@"' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'Stateful Player captured:' "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift"
grep -Fq 'activateStatefulPlayerCapture()' "$repo_dir/Sources/EeveeSpotify/Tweak.x.swift"
if grep -A4 -F 'class NowPlayingPlatformSwiftServiceImplementationHook' \
    "$repo_dir/Sources/EeveeSpotify/Lyrics/NowPlayingScrollViewControllerInstanceHook.x.swift" | \
    grep -Fq 'typealias Group = NonIOS14PremiumPatchingGroup'; then
    echo "modern stateful-player capture must not depend on premium hook activation" >&2
    exit 1
fi
if grep -Eq 'observedIsPlaying|elapsedMs' \
    "$source_dir/LyricsTimelinePlayerBridge.swift"; then
    echo "timeline player must fail closed instead of trusting or extrapolating observer playback state" >&2
    exit 1
fi
grep -Fq '} else if hasStateTrack {' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'let matchingPlayerTrack = liveTrackID == trackID ? playerTrack : nil' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'setIsPaused:' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'EeveeInvokeBool' "$repo_dir/Sources/EeveeSpotifyC/Tweak.m"
grep -Fq 'function cueNextWord()' "$timeline_bundle_dir/app.js"
grep -Fq 'addEventListener("click", cuePrimary)' "$timeline_bundle_dir/app.js"
grep -Fq 'Intl.Segmenter' "$timeline_bundle_dir/editor-state.js"
grep -Fq 'returnType(method) == "v"' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'let liveTrackID = currentTrackID()' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'typedef void (*SeekFn)(id, SEL, double);' "$repo_dir/Sources/EeveeSpotifyC/Tweak.m"
grep -Fq 'closeAttemptID' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'fileSizeKey' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'function buildWords(base, translation, oldWords)' "$timeline_bundle_dir/editor-state.js"
grep -Fq 'State.viewLine(editorState, index)' "$timeline_bundle_dir/app.js"
grep -Fq 'class="lyric-field lyric-field-translation"' "$timeline_bundle_dir/index.html"
grep -Fq '.line-copy small:empty' "$timeline_bundle_dir/style.css"
grep -Fq 'const delimiter = asciiParenthesesBalanced(left)' "$timeline_bundle_dir/editor-state.js"
grep -Fq 'const VERSION = 2;' "$timeline_bundle_dir/editor-state.js"
if grep -Eq 'ensureTranslationAlternative|alternativeTranslation|bestTranslationAlternative' "$timeline_bundle_dir/editor-state.js"; then
    echo "timeline translations must not read from or write to alternatives" >&2
    exit 1
fi
grep -Fq 'State.splitTranslation(State.selectedLineText' "$bundle_dir/app.js"
grep -Fq 'State.buildWords(base.editor.value, translation.editor.value)' "$bundle_dir/app.js"
grep -Fq 'const PROJECT_VERSION = 2;' "$bundle_dir/editor-state.js"
grep -Fq 'words: selectedLineText(state, line.index)' "$bundle_dir/editor-state.js"
if grep -Fq 'edits: state.edits' "$bundle_dir/editor-state.js"; then
    echo "share editor v2 projects must materialize edits into line.words" >&2
    exit 1
fi
grep -Fq 'loadDocument(payload) {' "$timeline_bundle_dir/app.js"
grep -Fq 'function submitRetranslation()' "$timeline_bundle_dir/app.js"
grep -Fq 'function applyRetranslation(makeStatic)' "$timeline_bundle_dir/app.js"
grep -Fq 'id="retranslate-static-badge"' "$timeline_bundle_dir/index.html"
grep -Fq 'id="segments-button"' "$timeline_bundle_dir/index.html"
grep -Fq 'id="segments-load-conflict"' "$timeline_bundle_dir/index.html"
grep -Fq 'command: "segmentsGet", trackId' "$timeline_bundle_dir/app.js"
grep -Fq 'command: "segmentsPut", payload' "$timeline_bundle_dir/app.js"
grep -Eq 'class="([^"]*[[:space:]])?mobile-workspace-tabs([[:space:]][^"]*)?"' "$timeline_bundle_dir/index.html"
grep -Fq 'function activateMobileView(name)' "$timeline_bundle_dir/app.js"
grep -Fq 'class="primary-command-dock"' "$timeline_bundle_dir/index.html"
grep -Fq '$("#dock-cue-primary").addEventListener("click", cuePrimary)' "$timeline_bundle_dir/app.js"
grep -Fq 'grid-template-rows: auto auto auto minmax(0, 1fr) auto;' "$timeline_bundle_dir/style.css"
grep -Fq 'grid-template-columns: repeat(3, minmax(0, 1fr));' "$timeline_bundle_dir/style.css"
grep -Fq 'overflow-x: hidden;' "$timeline_bundle_dir/style.css"
grep -Fq 'maximum-scale=1, user-scalable=no' "$timeline_bundle_dir/index.html"
grep -Fq 'class="mobile-tool-dock"' "$bundle_dir/index.html"
grep -Fq 'data-mobile-tool="export"' "$bundle_dir/index.html"
grep -Fq 'activateMobileTool(name)' "$bundle_dir/app.js"
grep -Fq 'grid-template-columns: repeat(6, minmax(0, 1fr));' "$bundle_dir/style.css"
grep -Fq 'grid-template-rows: auto minmax(0, 1fr) auto minmax(180px, 42%);' "$bundle_dir/style.css"
grep -Fq 'width: auto;' "$bundle_dir/style.css"
grep -Fq 'height: 100%;' "$bundle_dir/style.css"
grep -Fq 'max-block-size: 100%;' "$bundle_dir/style.css"
grep -Fq 'maximum-scale=1, user-scalable=no' "$bundle_dir/index.html"
grep -Fq -- '-webkit-user-select: none;' "$bundle_dir/style.css"
grep -Fq -- '-webkit-touch-callout: none;' "$bundle_dir/style.css"
grep -Fq 'overflow: auto;' "$bundle_dir/style.css"
grep -Fq 'inspector.scrollTop = 0;' "$bundle_dir/app.js"
grep -Fq 'grid-template-columns: repeat(3, minmax(0, 1fr));' "$bundle_dir/style.css"
grep -Fq 'env(safe-area-inset-bottom)' "$bundle_dir/style.css"
grep -Fq 'max-width: 560px;' "$bundle_dir/style.css"
if awk '
    /#preview-canvas[[:space:]]*\{/ { in_canvas = 1 }
    in_canvas && /(dvh|svh)/ { found = 1 }
    in_canvas && /}/ { in_canvas = 0 }
    END { exit(found ? 0 : 1) }
' "$bundle_dir/style.css"; then
    echo "preview canvas must retain a legacy-WebKit-safe width fallback" >&2
    exit 1
fi
for controller in LyricsShareEditorViewController.swift LyricsTimelineEditorViewController.swift; do
    grep -Fq 'webView.scrollView.contentInsetAdjustmentBehavior = .never' "$source_dir/$controller"
    grep -Fq 'webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)' "$source_dir/$controller"
    grep -Fq 'webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)' "$source_dir/$controller"
done
if sed -n '/struct LyricsShareEditorTrack: Encodable {/,/^}/p' \
    "$source_dir/LyricsShareEditorDocument.swift" | grep -Eq 'cover|artwork|Data'; then
    echo "artwork must remain outside the server request track payload" >&2
    exit 1
fi
grep -Fq 'struct LyricsEditorCardEntryGroup: HookGroup' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'struct LyricsEditorFullscreenEntryGroup: HookGroup' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'struct LyricsEditorSingalongEntryGroup: HookGroup' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'Lyrics_CardElementImpl.CardHeaderView' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'Lyrics_FullscreenElementPageImpl.FullscreenElementViewController' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'Lyrics_FullscreenSingalongPageImpl.FullscreenElementViewController' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'func didMoveToWindow()' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'func layoutSubviews()' "$source_dir/LyricsEditorEntryHooks.x.swift"
if grep -Fq 'func initWithFrame(' "$source_dir/LyricsEditorEntryHooks.x.swift" ||
   grep -Fq 'func initWithCoder(' "$source_dir/LyricsEditorEntryHooks.x.swift"; then
    echo "CardHeaderView unimplemented initializers must not be hooked" >&2
    exit 1
fi
grep -Fq 'private final class LyricsCardEntryRetryState: NSObject' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'weak var header: UIView?' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'var remainingAttempts = 8' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'CardHeaderView stack unavailable after lifecycle retries' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'guard header.window != nil else { return }' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'private struct LyricsHeaderButtonStyle' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq '"$__lazy_storage_$_shareButtonContainerView"' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq '"$__lazy_storage_$_expandButtonContainerView"' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq '"$__lazy_storage_$_translationButtonContainerView"' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq '"$__lazy_storage_$_vocalRemovalButtonContainerView"' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'headerButtonStyle(in: header, fallbackStack: stack)' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'let candidates = stack.arrangedSubviews + preferredContainers' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'private static func descendantButton(in view: UIView) -> UIButton?' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'guard !container.isHidden, container.alpha > 0.01' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'limitingHeight: stack.bounds.height' "$source_dir/LyricsEditorEntryHooks.x.swift"
if grep -Fq 'container.subviews.first(where: { $0 is UIButton }) as? UIButton' \
   "$source_dir/LyricsEditorEntryHooks.x.swift"; then
    echo "lyrics header style lookup must recurse through Spotify container views" >&2
    exit 1
fi
grep -Fq 'button.apply(headerStyle:' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'card entries attached:' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'preferredSymbolConfigurationForImage(in: .normal)' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'alpha = style.alpha' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'button.sizeToFit()' "$source_dir/LyricsEditorEntryHooks.x.swift"
if grep -Eq 'equalToConstant: 32|black\.withAlphaComponent\(0\.18\)|pointSize: 15' \
    "$source_dir/LyricsEditorEntryHooks.x.swift"; then
    echo "lyrics editor buttons must derive geometry and appearance from Spotify header controls" >&2
    exit 1
fi
grep -Fq 'LyricsEditorCardEntryGroup().activate()' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'LyricsEditorFullscreenEntryGroup().activate()' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'LyricsEditorSingalongEntryGroup().activate()' "$source_dir/LyricsEditorEntryHooks.x.swift"
if grep -Fq 'firstHorizontalStack' "$source_dir/LyricsEditorEntryHooks.x.swift"; then
    echo "lyrics card editor entries must fail closed when the confirmed stack ivar is unavailable" >&2
    exit 1
fi
grep -Fq 'launch: LyricsShareEditorLauncher.present' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'launch: LyricsTimelineEditorLauncher.present' "$source_dir/LyricsEditorEntryHooks.x.swift"
grep -Fq 'activateLyricsEditorEntries()' "$repo_dir/Sources/EeveeSpotify/Tweak.x.swift"
grep -Fq 'func present(from viewController: UIViewController)' "$source_dir/LyricsShareEditorLauncher.swift"
grep -Fq '(presenter as? UINavigationController)?.visibleViewController' "$source_dir/LyricsShareEditorLauncher.swift"
grep -Fq 'navigationController.viewControllers.first === self' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'navigationController.viewControllers.first === self' "$source_dir/LyricsTimelineEditorViewController.swift"

if grep -Fq 'matchesCurrentTrack' "$source_dir/LyricsTimelineEditorViewController.swift"; then
    echo "timeline save must not depend on player availability" >&2
    exit 1
fi

if grep -ERq 'previewID|cdn-link-previews|UIImageJPEGRepresentation' "$source_dir" "$bundle_dir"; then
    echo "forbidden Spotify preview/upload dependency found" >&2
    exit 1
fi

if grep -ERq 'previewID|spotifycdn|cdn-link-previews' "$timeline_bundle_dir"; then
    echo "forbidden Spotify preview/upload dependency found in timeline editor" >&2
    exit 1
fi

if [ "$#" -eq 1 ]; then
    web_source=$1
    for file in index.html app.js editor-state.js renderer.js style.css; do
        cmp "$web_source/$file" "$bundle_dir/$file"
    done
fi


if [ "$#" -ge 2 ]; then
    timeline_source=$2
    for file in index.html app.js editor-state.js style.css; do
        cmp "$timeline_source/$file" "$timeline_bundle_dir/$file"
    done
fi

git -C "$repo_dir" diff --check
echo "share editor static verification passed"
