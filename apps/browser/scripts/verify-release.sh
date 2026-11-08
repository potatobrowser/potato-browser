#!/usr/bin/env bash
# Fails unless each DMG and the app inside it are Developer ID signed, notarized and stapled, so
# Gatekeeper opens them without a warning; then launches the app for this Mac's architecture.
# Each zip (what in-app updates install) must hold the same: a stapled app for its architecture,
# unpacked with ditto as Squirrel.Mac does, with the app-update.yml electron-updater reads.
# Usage: scripts/verify-release.sh release/Potato-Browser-<version>-<arch>.{dmg,zip}...
set -euo pipefail

# stapler and spctl ask Apple's ticket service online; retry when the network drops.
retry() {
  local i
  for i in 1 2 3 4; do
    "$@" && return 0
    [ "$i" = 4 ] || { echo "retrying in $((i * 15))s: $*"; sleep $((i * 15)); }
  done
  return 1
}

# Prints a command's output and fails unless it contains the expected text.
expect() {
  local want=$1 out; shift
  out=$("$@" 2>&1) || { echo "$out"; return 1; }
  echo "$out"
  [[ "$out" == *"$want"* ]] || { echo "expected: $want"; return 1; }
}

host=$(uname -m); [ "$host" = x86_64 ] && host=x64

# The designated requirement released apps carry. Squirrel.Mac installs an update only if it
# satisfies the running app's, so an app signed by another team would never reach anyone.
team=${RELEASE_TEAM_ID:-G482FZWRVW}
requirement="=identifier \"com.potatobrowser.app\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = $team"

verify_zip() {
  local zip=$1 dir app arch want version
  dir=$(mktemp -d)
  ditto -x -k "$zip" "$dir"
  app="$dir/Potato Browser.app"
  codesign --verify --deep --strict -vv "$app"
  codesign --verify -R "$requirement" "$app"
  retry xcrun stapler validate "$app"
  retry expect 'source=Notarized Developer ID' spctl --assess --type execute -vv "$app"
  test -f "$app/Contents/Resources/app-update.yml" || { echo "no app-update.yml in $zip"; return 1; }
  arch=$(lipo -archs "$app/Contents/MacOS/Potato Browser")
  want=arm64; [[ "$zip" == *-x64.zip ]] && want=x86_64
  [ "$arch" = "$want" ] || { echo "$zip holds a $arch app"; return 1; }
  version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
  [[ "$(basename "$zip")" == "Potato-Browser-$version-"* ]] || { echo "$zip holds version $version"; return 1; }
  rm -rf "$dir"
}

for dmg in "$@"; do
  if [[ "$dmg" == *.zip ]]; then
    echo "== $dmg"
    verify_zip "$dmg"
    continue
  fi
  echo "== $dmg"
  retry xcrun stapler validate "$dmg"
  retry expect 'source=Notarized Developer ID' spctl --assess --type open --context context:primary-signature -vv "$dmg"
  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
  app="$mnt/Potato Browser.app"
  codesign --verify --deep --strict -vv "$app"
  codesign --verify -R "$requirement" "$app"
  expect 'com.apple.security.cs.allow-jit' codesign -d --entitlements - "$app"
  retry xcrun stapler validate "$app"
  retry expect 'source=Notarized Developer ID' spctl --assess --type execute -vv "$app"
  if [[ "$dmg" == *"-$host.dmg" ]]; then
    # Hardened runtime without the right entitlements kills the renderer at once.
    profile=$(mktemp -d)
    POTATO_USER_DATA="$profile" "$app/Contents/MacOS/Potato Browser" >/dev/null 2>&1 &
    pid=$!
    sleep 20
    alive=0; kill -0 "$pid" 2>/dev/null && alive=1
    renderer=$(pgrep -f 'Potato Browser Helper \(Renderer\)' | wc -l | tr -d ' ')
    kill "$pid" 2>/dev/null || true; sleep 3; pkill -f "$mnt" 2>/dev/null || true
    echo "launch: running=$alive renderers=$renderer"
    [ "$alive" = 1 ] && [ "$renderer" -gt 0 ] || { echo "the signed app did not stay up"; hdiutil detach "$mnt" -force >/dev/null; exit 1; }
  fi
  hdiutil detach "$mnt" >/dev/null || hdiutil detach "$mnt" -force >/dev/null
done
echo "all DMGs and zips pass Gatekeeper"
