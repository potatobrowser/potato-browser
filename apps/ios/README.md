# Potato Browser for iPhone and iPad

The iOS app: a native SwiftUI browser around `WKWebView` with the same four features as the Mac
app. Every iOS browser runs on WebKit (Apple's rule outside the EU and Japan, and Electron does
not run on iOS anyway), so this is not a port of the Electron app: it reuses the Mac app's
in-page engines and filter lists and does the rest natively.

## How the features work on iOS

- **AI Shield**: `apps/browser/src/content/shield` runs unchanged as a content world user script
  (page scripts cannot see it). Its CSS goes into constructed stylesheets adopted by the
  document. The rules' AI-only requests are blocked by a small WebKit rule list; Google AI Mode
  redirects and the AI chatbot block happen in the navigation policy.
- **No AI in the engine**: WebKit has no feature switches, so the app turns off what an app can
  (Writing Tools, inline predictions, Genmoji in web views), never asks for speech recognition (so
  WebKit refuses it), and a page world script removes the AI web API globals in every frame.
  Settings > No AI in the engine runs the Mac app's purity check on the device.
- **Ad blocker**: the pinned filter lists are converted at build time (`web/contentblocker.ts`)
  into WebKit rule lists, one per group (ads, trackers, cookie notices, annoyances), compiled once
  on the device. The Ghostery engine runs in JavaScriptCore inside the app for cosmetics,
  scriptlets (installed as page world scripts for each navigation, before page scripts), generic
  hiding rules and the per-page counts. Lists update daily through potatobrowser.com, like the
  Mac app's.
- **Flags**: `apps/browser/src/content/flags` runs in the content world; lookups and votes go
  through native code with the same k-anonymity protocol (CryptoKit SHA-256, URLSession).

WKWebView has no synchronous messages, so the per-page config the Mac preload reads with
`sendSync` is computed in `decidePolicyFor navigationAction` and installed as a document-start
user script before the page loads. Each tab has its own `WKUserContentController` for that.

### Differences from the Mac app

- Ad blocking: WebKit rule lists only block. uBlock's harmless stand-ins (`redirect=`) and
  `$csp` filters need redirect and header actions that WebKit honors only for Safari
  extensions, so those requests are blocked outright and `$csp` filters are skipped. The
  per-page count covers the resources a page references in its markup (scripts, frames,
  images, styles), checked against the filters.
- Global Privacy Control is sent as `navigator.globalPrivacyControl` only: WebKit gives apps no
  way to add a request header.
- On iPhone, sites send their mobile layouts. Checked on them so far: the shield on Google search,
  flags on YouTube (m.youtube.com) and Reddit. Other sites' mobile markup may need new rules.
- Import reads bookmark HTML files and Safari's export (Settings > Apps > Safari > Export); other
  browsers' profiles are out of an app's reach.
- Default browser needs Apple's browser entitlement, which is requested from Apple separately.

## Build and run

You need a Mac with Xcode 27, [XcodeGen](https://github.com/yonaskolb/XcodeGen), Node.js 22 and
pnpm 12.

```sh
pnpm install
pnpm --filter @potato/ios build:web     # WebResources/: scripts, rule lists, engines, lists
cd apps/ios && xcodegen generate        # PotatoBrowser.xcodeproj from project.yml
open PotatoBrowser.xcodeproj
```

`build:web` downloads the filter lists pinned in `apps/browser/filters/lock.json` (shared with
the Mac app) and needs to run again when they or the in-page code change.

## Tests

```sh
pnpm --filter @potato/ios test           # converter and parity with the Mac app (vitest)
xcodebuild test -project PotatoBrowser.xcodeproj -scheme PotatoBrowser \
  -destination 'platform=iOS Simulator,name=<simulator>'   # unit tests and UI tests
node scripts/e2e.mjs --build             # end to end, see below
```

- Unit tests (XCTest): the address bar's URL or search decision (the Mac app's cases), settings,
  the profile database, flag hashes against `@potato/shared`, import, the shield's matching and AI
  Mode redirect, every shipped rule list compiling in WebKit, the engine in JavaScriptCore, and
  links from other apps (the URL scheme, and what the share extension reads from a share).
- UI tests (XCUITest): first run, browsing, tabs and private tabs, popups, `target=_blank`,
  JavaScript dialogs, bookmarks, a tap on a page right after launch, links from other apps (the
  URL scheme, and Open in Potato from Safari's share sheet), pull to refresh, swiping the address
  bar between tabs, and the keyboard shortcuts. The newer tests load their pages from a small
  server on 127.0.0.1 inside the test runner, so they need no internet. Run the shortcut tests on
  an iPad simulator as well (`-only-testing:PotatoBrowserUITests/KeyboardTests`). Unless a Mac
  keyboard is attached, the simulator runs its on-screen keyboard for a focused page or text field,
  and it keeps Esc and Cmd+W (on iPhone Cmd+F too) for itself, as it does in Safari. The tests press
  those with nothing focused, and tap Cancel where Esc would not arrive.
- End to end (`scripts/e2e.mjs`): the app on the simulator against the Mac app's fixture sites,
  served under their real hostnames through a local proxy with a test CA the simulator trusts,
  and the real flags Worker under `wrangler dev`. It checks the shield on every fixture site, the
  ad blocker (no ad or tracker request leaves the browser, cosmetics, scriptlets, own filters,
  per-site switch), flags (buttons, labels, hiding, votes reaching the Worker, private tabs), the
  chatbot block, downloads, search, the engine check and session restore. `-potato-test` makes
  the app take its steps from `POTATO_TEST_STEPS` (`PotatoBrowser/App/TestRunner.swift`);
  `scripts/simrun.mjs` runs any list of steps, also against live sites.

## TestFlight

```sh
cd apps/ios
scripts/testflight.sh [--wait]
```

It builds the web resources, archives with automatic signing through an App Store Connect API
key, uploads, and makes sure the internal TestFlight group "Team" has every App Store Connect user
as a tester. `--wait` waits until Apple has processed the build. The build number is the commit
count. The key goes in `apps/ios/.env` (not committed):

```sh
ASC_KEY_ID=...        # key at ~/.appstoreconnect/private_keys/AuthKey_<id>.p8, or set ASC_KEY_PATH
ASC_ISSUER_ID=...
```

The key needs the Admin role: xcodebuild then creates the distribution certificate and profiles
in the cloud. The app's bundle id is `com.potatobrowser.app`, as on the Mac; its share extension
(Open in Potato) is `com.potatobrowser.app.share`, signed the same way.
