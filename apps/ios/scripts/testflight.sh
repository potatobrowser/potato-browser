#!/bin/sh
# Archives Potato Browser for iOS and uploads it to TestFlight with an App Store Connect API key:
# ASC_KEY_ID and ASC_ISSUER_ID in apps/ios/.env (or the environment), the key itself at
# ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (or ASC_KEY_PATH). The key needs the
# Admin role: xcodebuild then creates the distribution certificate and profile in the cloud.
# The build number is the commit count, so every commit uploads a newer build.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && . ./.env
: "${ASC_KEY_ID:?set ASC_KEY_ID in apps/ios/.env}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID in apps/ios/.env}"
key=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}
[ -f "$key" ] || { echo "No App Store Connect key at $key" >&2; exit 1; }
build=$(git rev-list --count HEAD)

node scripts/build-web.mjs
xcodegen generate --quiet
rm -rf build/PotatoBrowser.xcarchive build/export
auth="-allowProvisioningUpdates -authenticationKeyPath $key -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
xcodebuild -quiet -project PotatoBrowser.xcodeproj -scheme PotatoBrowser -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/PotatoBrowser.xcarchive \
  -derivedDataPath build/ReleaseData $auth CURRENT_PROJECT_VERSION="$build" archive
xcodebuild -exportArchive -archivePath build/PotatoBrowser.xcarchive \
  -exportOptionsPlist scripts/ExportOptions.plist -exportPath build/export $auth
echo "Uploaded build $build"
node scripts/asc.mjs testers
if [ "${1-}" = "--wait" ]; then node scripts/asc.mjs wait "$build"; fi
