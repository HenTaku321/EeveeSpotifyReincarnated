#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

node --test Tools/standalone-package.test.js
node --test Tools/motion-artwork-source.test.js
node --test Tools/share-editor-assets.test.js
node --check layout/Library/Application\ Support/EeveeSpotify.bundle/ShareEditor/app.js
node --check layout/Library/Application\ Support/EeveeSpotify.bundle/TimelineEditor/app.js

test -f "layout-standalone/Library/Application Support/MITMLyricsStudio.bundle/Info.plist"
for file in index.html app.js editor-state.js renderer.js style.css icons.js repository-source.js tokens.css; do
    test -f "layout/Library/Application Support/EeveeSpotify.bundle/ShareEditor/$file"
done
for file in index.html app.js editor-state.js style.css browser-host.js icons.js tokens.css; do
    test -f "layout/Library/Application Support/EeveeSpotify.bundle/TimelineEditor/$file"
done
grep -Fq 'MITM_LYRICS_STANDALONE' Makefile.standalone
grep -Fq 'Sources/EeveeSpotify/ShareEditor' Makefile.standalone
grep -Fq 'Sources/MITMLyricsStudio' Makefile.standalone
grep -Fq 'Sources/MITMLyricsStudioC' Makefile.standalone

if grep -Eq 'EeveeSpotify\.dylib|EeveeSwiftProtobuf' \
    .github/workflows/build-standalone-lyrics-studio.yml; then
    echo "standalone workflow must not package Eevee binaries or frameworks" >&2
    exit 1
fi

echo "standalone editor static verification passed"
