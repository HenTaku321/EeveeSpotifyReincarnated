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

for file in index.html app.js editor-state.js renderer.js style.css; do
    test -f "$bundle_dir/$file"
done

for file in index.html app.js editor-state.js style.css; do
    test -f "$timeline_bundle_dir/$file"
done

node --check "$bundle_dir/app.js"
node --check "$bundle_dir/editor-state.js"
node --check "$bundle_dir/renderer.js"
node --check "$timeline_bundle_dir/app.js"
node --check "$timeline_bundle_dir/editor-state.js"

grep -Fq 'name: "shareEditor"' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'X-MITM-Lyrics-Token' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'Documents/Exports/' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'Documents/ShareEditor/Projects' "$source_dir/LyricsShareEditorLauncher.swift"
grep -Fq "hide('#load-button')" "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'window.ShareEditor.serializeState();' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'window.ShareEditor.restoreState' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'maximumBytes = 8 * 1024 * 1024' "$source_dir/LyricsShareEditorBridge.swift"
grep -Fq 'MPMediaItemPropertyAlbumTitle' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'scheme != "https", !isLoopback' "$source_dir/LyricsShareEditorConfiguration.swift"
grep -Fq 'completionHandler(nil)' "$source_dir/LyricsShareEditorNetwork.swift"
grep -Fq 'dataTask.cancel()' "$source_dir/LyricsShareEditorNetwork.swift"
grep -Fq 'returnedTrackID.trimmingCharacters' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'scriptMessage.frameInfo.isMainFrame' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'removeScriptMessageHandler(forName: "shareEditor")' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'webView.isUserInteractionEnabled = false' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'preserveUnreadableProject' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'case unreadable' "$source_dir/LyricsShareEditorViewController.swift"
grep -Fq 'normalizedTrackID.utf8.count == 22' "$source_dir/LyricsShareEditorDocument.swift"
grep -Fq 'token.utf8.count <= 4096' "$source_dir/LyricsShareEditorConfiguration.swift"
grep -Fq 'name: "timelineEditor"' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'editEndpointURL' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'window.LyricsTimelineEditor.serializeState();' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'removeScriptMessageHandler(forName: "timelineEditor")' "$source_dir/LyricsTimelineEditorViewController.swift"
grep -Fq 'expectedTrackID' "$source_dir/LyricsTimelinePlayerBridge.swift"
grep -Fq 'LyricsTimelinePlayerBridge.shared.capture' "$repo_dir/Sources/EeveeSpotify/SponsorBlock/SponsorBlockHooks.x.swift"
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
grep -Fq 'bestTranslationAlternative' "$timeline_bundle_dir/editor-state.js"
grep -Fq 'loadDocument(payload) { editorState = State.createState(payload); history = []; future = []; render(); bridge({ command: "getPlayerState" }); return true; }' "$timeline_bundle_dir/app.js"

if grep -Fq 'matchesCurrentTrack' "$source_dir/LyricsTimelineEditorViewController.swift"; then
    echo "timeline save must not depend on player availability" >&2
    exit 1
fi

if grep -ERq 'previewID|spotifycdn|cdn-link-previews|UIImageJPEGRepresentation' "$source_dir" "$bundle_dir"; then
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
