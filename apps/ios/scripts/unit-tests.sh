#!/bin/bash
# Runs the XCTest unit tests on an iOS simulator, as CI and the TestFlight deploy do.
# POTATO_TEST_SIM names the simulator (default "potato-unit", an iPhone 17 made when missing).
set -euo pipefail
cd "$(dirname "$0")/.."
sim=${POTATO_TEST_SIM:-potato-unit}
if ! xcrun simctl list devices | grep -q " $sim ("; then
  xcrun simctl create "$sim" "iPhone 17" >/dev/null
fi
node scripts/build-web.mjs
xcodebuild -project PotatoBrowser.xcodeproj -scheme PotatoBrowser -destination "platform=iOS Simulator,name=$sim" \
  -derivedDataPath build/TestData -only-testing:PotatoBrowserTests test 2>&1 |
  grep -E --line-buffered "Test Case .*(passed|failed)|error:|Executed|\*\* TEST"
