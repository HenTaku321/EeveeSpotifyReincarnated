#!/bin/sh
set -eu

usage() {
    printf '%s\n' "Usage: $0 BASE_IPA ROOTLESS_DEB OUT_IPA" >&2
    printf '%s\n' "Replaces EeveeSpotify.dylib, EeveeSwiftProtobuf.framework, and EeveeSpotify.bundle in a local IPA." >&2
    exit 2
}

[ "$#" -eq 3 ] || usage

need_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'missing required command: %s\n' "$1" >&2
        exit 1
    }
}

for command in unzip zip ar tar ldid; do
    need_command "$command"
done

absolute_existing_path() {
    input=$1
    directory=$(CDPATH= cd -- "$(dirname -- "$input")" && pwd -P)
    printf '%s/%s\n' "$directory" "$(basename -- "$input")"
}

base_ipa=$(absolute_existing_path "$1")
deb=$(absolute_existing_path "$2")
out_ipa=$3
out_directory=$(CDPATH= cd -- "$(dirname -- "$out_ipa")" 2>/dev/null && pwd -P || true)
if [ -z "$out_directory" ]; then
    mkdir -p -- "$(dirname -- "$out_ipa")"
    out_directory=$(CDPATH= cd -- "$(dirname -- "$out_ipa")" && pwd -P)
fi
out_ipa="$out_directory/$(basename -- "$out_ipa")"
out_name=$(basename -- "$out_ipa")

[ -f "$base_ipa" ] || { printf 'IPA not found: %s\n' "$base_ipa" >&2; exit 1; }
[ -f "$deb" ] || { printf '.deb not found: %s\n' "$deb" >&2; exit 1; }
[ "$base_ipa" != "$out_ipa" ] || { printf 'refusing to overwrite the input IPA\n' >&2; exit 1; }
[ "$deb" != "$out_ipa" ] || { printf 'refusing to overwrite the input .deb\n' >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/eevee-ipa-splice.XXXXXXXX")
output_stage=$(mktemp -d "$out_directory/.eevee-ipa-output.XXXXXXXX")
staged_ipa="$output_stage/$out_name"
cleanup() {
	rm -rf -- "$work" "$output_stage"
}
trap cleanup EXIT HUP INT TERM

unzip -q "$base_ipa" -d "$work/ipa"
[ -z "$(find "$work/ipa" -type l -print -quit)" ] || {
    printf 'refusing IPA containing symbolic links\n' >&2
    exit 1
}
app="$work/ipa/Payload/Spotify.app"
main="$app/Spotify"
[ -f "$main" ] || { printf 'Payload/Spotify.app/Spotify is missing\n' >&2; exit 1; }
[ ! -L "$app" ] || { printf 'Spotify.app must not be a symbolic link\n' >&2; exit 1; }
[ ! -L "$main" ] || { printf 'Spotify executable must not be a symbolic link\n' >&2; exit 1; }

ldid -e "$main" > "$work/main.entitlements.plist"
[ -s "$work/main.entitlements.plist" ] || { printf 'main executable entitlements are empty\n' >&2; exit 1; }

mkdir -p "$work/deb-archive" "$work/deb-root"
(CDPATH= cd -- "$work/deb-archive" && ar x "$deb")
data_archive=$(find "$work/deb-archive" -maxdepth 1 -type f -name 'data.tar*' -print -quit)
[ -n "$data_archive" ] || { printf 'data.tar.* is missing from the .deb\n' >&2; exit 1; }
case "$data_archive" in
    *.tar.gz|*.tgz) tar -xzf "$data_archive" -C "$work/deb-root" ;;
    *.tar.xz) tar -xJf "$data_archive" -C "$work/deb-root" ;;
    *.tar.zst) tar --zstd -xf "$data_archive" -C "$work/deb-root" ;;
    *.tar.lzma) tar --lzma -xf "$data_archive" -C "$work/deb-root" ;;
    *.tar) tar -xf "$data_archive" -C "$work/deb-root" ;;
    *) printf 'unsupported data archive: %s\n' "$data_archive" >&2; exit 1 ;;
esac

source_dylib=$(find "$work/deb-root" -type f -name 'EeveeSpotify.dylib' -print -quit)
source_framework=$(find "$work/deb-root" -type d -name 'EeveeSwiftProtobuf.framework' -print -quit)
source_bundle=$(find "$work/deb-root" -type d -name 'EeveeSpotify.bundle' -print -quit)
[ -n "$source_dylib" ] || { printf 'EeveeSpotify.dylib is missing from the .deb\n' >&2; exit 1; }
[ -n "$source_framework" ] || { printf 'EeveeSwiftProtobuf.framework is missing from the .deb\n' >&2; exit 1; }
[ -f "$source_framework/EeveeSwiftProtobuf" ] || { printf 'framework executable is missing from the .deb\n' >&2; exit 1; }
[ -n "$source_bundle" ] || { printf 'EeveeSpotify.bundle is missing from the .deb\n' >&2; exit 1; }
[ -z "$(find "$source_dylib" "$source_framework" "$source_bundle" -type l -print -quit)" ] || {
    printf 'refusing .deb payload containing symbolic links\n' >&2
    exit 1
}

target_dylib="$app/Frameworks/EeveeSpotify.dylib"
target_framework="$app/Frameworks/EeveeSwiftProtobuf.framework"
target_bundle="$app/EeveeSpotify.bundle"
[ ! -L "$app/Frameworks" ] || { printf 'app Frameworks directory must not be a symbolic link\n' >&2; exit 1; }
mkdir -p "$app/Frameworks"
rm -rf "$target_dylib" "$target_framework" "$target_bundle"
cp -p "$source_dylib" "$target_dylib"
cp -R "$source_framework" "$target_framework"
cp -R "$source_bundle" "$target_bundle"

# The input IPA's app signature covers the old injected files. Remove stale
# bundle signatures, then sign the replacement Mach-O files and restore the
# main executable's original entitlement set. This is an ad-hoc TrollStore /
# AppSync splice; ordinary certificate sideloaders must sign the whole app.
rm -rf "$app/_CodeSignature" "$target_dylib/_CodeSignature" "$target_framework/_CodeSignature"
ldid -S "$target_dylib"
ldid -S "$target_framework/EeveeSwiftProtobuf"
ldid -S"$work/main.entitlements.plist" "$main"

(CDPATH= cd -- "$work/ipa" && zip -qry "$staged_ipa" Payload)
zip -T "$staged_ipa" >/dev/null
unzip -Z1 "$staged_ipa" | grep -E '/EeveeSpotify\.dylib$' >/dev/null
unzip -Z1 "$staged_ipa" | grep -E '/EeveeSwiftProtobuf\.framework/EeveeSwiftProtobuf$' >/dev/null
unzip -Z1 "$staged_ipa" | grep -E '/EeveeSpotify\.bundle/ShareEditor/index\.html$' >/dev/null
unzip -Z1 "$staged_ipa" | grep -E '/EeveeSpotify\.bundle/TimelineEditor/index\.html$' >/dev/null
mv -f -- "$staged_ipa" "$out_ipa"
printf 'spliced IPA: %s\n' "$out_ipa"
