#!/usr/bin/env bash
# Fails unless each DMG and the app inside it are Developer ID signed, notarized and stapled, so
# Gatekeeper opens them without a warning; then launches the app for this Mac's architecture.
# Usage: scripts/verify-release.sh release/Potato-Browser-<version>-<arch>.dmg...
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
for dmg in "$@"; do
  echo "== $dmg"
  retry xcrun stapler validate "$dmg"
  retry expect 'source=Notarized Developer ID' spctl --assess --type open --context context:primary-signature -vv "$dmg"
  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
  app="$mnt/Potato Browser.app"
  codesign --verify --deep --strict -vv "$app"
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
echo "all DMGs pass Gatekeeper"
