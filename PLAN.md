# Potato Browser: MVP plan

A macOS Chromium-based browser for people who want the web without AI.

## Product scope (MVP)

1. **A normal, complete browser**: tabs (reorder, reopen closed, pin-free), windows, private
   windows, omnibox with history/bookmark/search suggestions, back/forward/reload, find in page,
   zoom, downloads, history, bookmarks (bar + manager), session restore, permissions prompts,
   context menus, popups/OAuth windows, HTML5 fullscreen, print, default-browser support,
   profile import (bookmarks + history) from Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium,
   Firefox and Safari.
2. **AI Shield**: AI features of major websites are hidden by default (Google AI Overviews and
   AI Mode, Gmail/Docs Gemini, YouTube Ask, Bing Copilot, DuckDuckGo Assist, X Grok, Meta AI on
   Facebook/Instagram/WhatsApp/Messenger, LinkedIn AI writing, Reddit Answers, Amazon Rufus,
   and more). A shield button in the toolbar shows what was hidden and turns hiding off/on for
   the current site.
3. **No AI in the engine**: Chromium's built-in AI web APIs (Prompt/LanguageModel, Summarizer,
   Writer, Rewriter, Proofreader, Translator, LanguageDetector, Classifier, Embeddings), WebNN
   and speech recognition are switched off at engine level. There is no on-device model and no
   AI browser feature. Verified by e2e tests (main frame and workers).
4. **Community AI flags**: users anonymously flag posts as AI-generated on Reddit, X, Instagram,
   Facebook, Threads, LinkedIn, YouTube, Bluesky and TikTok. Per user setting, flagged posts are
   **hidden** (collapsed placeholder), **labelled**, or **ignored**, with a flag-count threshold.
5. **Landing page** on Cloudflare with DMG downloads (Apple Silicon + Intel).

## Architecture

```
apps/browser      Electron 45 (Chromium 156) app, TypeScript
  src/main        main process: windows, tabs, sessions, sqlite profile db, importers, flags client
  src/preload     ui.ts (browser chrome), web.ts (every tab frame: shield + flags + potato:// pages API)
  src/content     in-page engines: shield rules + heuristics, flag adapters + injected UI
  src/renderer    React UI: chrome (tab strip, toolbar, popovers) and internal potato:// pages
  test            vitest unit tests, Playwright e2e (fixture sites served via https interception)
apps/web          Cloudflare Worker: landing page (static assets), flags API (D1), downloads (R2)
packages/shared   flag key format, hashing spec, API types shared by browser and worker
```

Key decisions:

- **Electron over a Chromium source fork**: a source fork needs ~100 GB and many hours per build;
  Electron ships the same Blink/V8 engine but without Chrome's //chrome layer, so there is no
  Gemini Nano, no optimization-guide model downloads and no AI browser features to begin with.
  The remaining engine-level AI APIs are disabled with `--disable-features` and
  `--disable-blink-features`.
- **Window = BaseWindow + WebContentsViews**. Each tab is a view; the chrome UI is a transparent
  view on top that grows to full-window size while a popover (omnibox suggestions, shield
  panel, menus) is open, so popovers can float over page content.
- **AI Shield** injects a user-origin stylesheet (`!important` user rules beat page rules) at
  document start via `webFrame.insertCSS`, plus a MutationObserver for text/aria-label
  heuristics (localized strings). Rules live in a typed catalog; per-site state is fetched
  synchronously at document start so nothing flashes.
- **Flags privacy**: content keys (`reddit:t3_abc`) never leave the device in clear text.
  Lookups send 20-bit SHA-256 prefixes (k-anonymity, like Safe Browsing); flagging sends the
  full hash. Voters are a random install id, stored server-side only as an HMAC. No accounts,
  no IP storage; abuse is limited by rate limits.
- **Storage**: `node:sqlite` (built into Electron's Node 24) for history, bookmarks, downloads,
  site settings; JSON for settings and session.
- **Testing**: e2e tests run the real app with a temp profile, real hostnames served from local
  fixtures (main-process https interception in test mode) and the real Worker running under
  `wrangler dev` with a local D1.

## Milestones (each ends with a commit)

1. Scaffold monorepo, tooling, plan.
2. Browser shell: windows, tabs, omnibox, menus, internal pages, engine switches.
3. Profile data: history, bookmarks, downloads, private mode, settings, session restore.
4. Profile import.
5. AI Shield + per-site toggle, live-verified on public sites.
6. Flags API (Worker + D1) and in-page adapters with hide/label/ignore.
7. E2E + unit suites green.
8. Landing page deployed to Cloudflare.
9. Packaged DMGs (arm64 + x64) uploaded to R2, downloadable from the live site; final QA.

## Release constraints

- Releases are signed with the Developer ID Application certificate and notarized in the release
  workflow; builds from source are ad-hoc signed.

## Ad blocker (0.5.0)

A built-in ad and tracker blocker, on by default, as the fourth main feature next to the AI
Shield, the engine switches and the flags.

Investigation (2026-11-07):

- **Engine**: `@ghostery/adblocker` (MPL-2.0, pure TypeScript, used by Ghostery's extensions).
  It reads EasyList and uBlock Origin syntax: network filters, cosmetic filters, procedural
  selectors (`:has-text`, `:upward`, ...), scriptlets and redirect resources. Measured on the
  default lists: about 0.5 s to compile, 10 ms to load a compiled engine, 8 us per request
  lookup. Brave's `adblock-rust` would be faster per lookup but is a native module (two
  architectures, rebuilds per Electron), for no gain a user would notice.
- **Not `@ghostery/adblocker-electron`**: it registers its own `webRequest.onBeforeRequest`,
  and Electron allows one listener per session (the AI Shield and the chatbot block already use
  it). It also injects cosmetics into the main frame only, and scriptlets asynchronously.
- **Lists** come from Ghostery's CDN (`cdn.ghostery.com/adblocker/resources/<list>`), which
  republishes EasyList, EasyPrivacy and uBlock Origin's lists within hours of upstream, under
  immutable revision URLs, plus uBlock Origin's scriptlet resources in the engine's format.
  (Ghostery's GitHub mirror of the same lists is three months old.) Peter Lowe's list is left
  out: its terms of use are unclear.

Design:

- **Groups**: Ads (EasyList, uBlock filters, badware, resource abuse, unbreak, quick fixes; always
  on with the blocker), Trackers (EasyPrivacy, uBlock privacy; on), Cookie notices (EasyList
  Cookie, uBlock cookie annoyances; off) and Annoyances (uBlock annoyances; off), plus the
  user's own filters.
- **Pinned and bundled**: `apps/browser/filters/lock.json` pins each list's revision and SHA-256.
  The build downloads exactly those files (cached in `.cache/filters`), compiles the default
  engine into the app and ships the lists themselves (gzipped) for other combinations. So a
  fresh install blocks from its very first request, offline, and a release build is
  reproducible from its tag.
- **Network**: one `onBeforeRequest` pipeline: chatbot block, AI Shield, then the ad blocker for
  every subresource (never a main frame). Redirect filters get uBlock's neutered stand-ins (a
  harmless `gpt.js` instead of a blocked one), `$csp` filters add headers.
- **Cosmetics**: the web preload asks for each frame's styles and scriptlets synchronously at
  document start, inserts the styles as user stylesheets and runs scriptlets in the page's world
  before page scripts. After DOMContentLoaded it watches ids and classes for generic rules and
  applies procedural selectors.
- **Updates**: once a day the browser asks potatobrowser.com for the latest revisions
  (`GET /api/v1/filters?lists=...`), downloads changed lists through the Worker (which caches
  Ghostery's immutable files at the edge, so lists are not hotlinked from every install),
  recompiles in a utility process and swaps the engine without a restart. The request says which
  lists, nothing about the user. It can be turned off.
- **UI**: a toolbar button with the number of ads and trackers blocked on the page; its panel
  turns blocking off for one site (and reloads it) and lists the top blocked domains. Settings
  has the groups, site exceptions, own filters, list status and "Update now". The new tab page
  counts what was blocked today.
- **Validation**: unit tests (matching, settings, updater, Worker endpoint), e2e tests on fixture
  pages that load real ad and tracker URLs (Google Publisher Tag, AdSense, Google Analytics,
  Facebook pixel) and carry ad markup, plus live checks against real sites and public ad block
  test pages.

## Status (2026-11-07)

All nine milestones are done and committed.

- Version 0.3.0 is published: DMGs for Apple Silicon and Intel, ad-hoc signed, downloadable
  from https://potatobrowser.com with SHA-256 checksums.
- Tests: 64 unit tests (shared 4, worker 11, browser 49) and 52 e2e tests, also run against the
  packaged app. The AI Shield was additionally checked on live Google (saved real SERP DOM),
  Bing, DuckDuckGo, YouTube, Amazon and Instagram; flag adapters on live Reddit, YouTube,
  Bluesky and Threads.
- Bugs the tests caught and fixed: quit hang after switching tabs, Chrome history import
  overflow, Trusted Types breaking injected UI on YouTube, lost titles on reload, a flag lookup
  race, a Worker entrypoint export rejected by workerd, omnibox click and autocomplete races.
- An independent security review led to 0.1.1: screen sharing always asks first, votes count
  once per network, certificate exceptions are per certificate and session.
- 0.1.2 reworked the welcome page: search engine choice (DuckDuckGo or Google), flag modes
  shown as miniature feeds, numbered setup steps, a sticky Start browsing bar, and a guided
  Safari import that opens Full Disk Access and resumes on its own (also after a relaunch).
- 0.2.0 renamed No-AI Browser to Potato Browser: name, potato app icon and brand mark,
  `potato://` internal pages, `@potato/*` packages. Existing profiles move to the new folder on
  first launch. The Worker, its URL, D1, R2 and the flag hash domain keep the old name (see
  README, Former name).
- The site moved to https://potatobrowser.com (Worker custom domain; www and the workers.dev
  pages redirect there, the workers.dev API keeps serving older builds). Site and app copy got
  a light potato voice ("Grown, not generated."). 0.3.0 carries the new copy and calls the API
  on potatobrowser.com; it is published (both DMGs, checksums on the site).

- 0.4.0 makes the project open source (MIT) at https://github.com/potatobrowser/potato-browser.
  The development repository's main is mirrored there by srv-deploy (`scripts/mirror-public.sh`),
  which also pushes the `v<version>` tag; the release workflow on GitHub Actions builds, attests
  and publishes the DMGs, and the site reads releases from there instead of R2. A code review
  before publishing fixed a certificate warning bypass through potato://action links,
  cross-site flagging through the API, forged clicks on the flag button and private-window
  flag linkage (see CHANGELOG).

- 0.4.2 is the first signed release: Developer ID signature, hardened runtime, apps and DMGs
  notarized and stapled by the release workflow, which also checks Gatekeeper accepts them and
  launches the app before publishing. `brew install --cask potatobrowser/tap/potato-browser`
  installs it; the workflow updates github.com/potatobrowser/homebrew-tap on each release.
  0.4.1 was tagged but never published (Apple's ticket service dropped connections from the
  runner; stapling now retries).

- 0.5.0 adds the built-in ad blocker (see Ad blocker above). Validated by 13 unit tests on the
  pinned lists, 3 Worker tests, 6 new e2e tests (also against the packaged app; the full suite is
  60 tests), and live checks on 2026-11-07: adblock-tester.com scores 99/100 with the blocker on
  and 41/100 with it off; video ads played on 2 of 3 YouTube videos with it off and on none with
  it on (ad data stripped, videos play); visible ad slots on the Guardian went from 13 to 0 and
  on CNN from 7 to 0; with cookie notices on, the consent walls on Speedtest and the Guardian are
  gone. The packaged app loads the engine in 19 ms; other list choices compile in about 0.5 s.
  Found and fixed on the way: Chromium refuses redirects to `data:` URLs (stand-ins now come from
  `potato-res://`), and uBlock scriptlets must each run in their own block or their shared
  `proxyApplyFn` sends `Function.prototype.toString` into infinite recursion (YouTube).
  An independent review before release led to: trusted scriptlets (which take code as
  arguments) allowed only from uBlock's own lists and the user's filters, since Ghostery's engine
  does not enforce uBlock's trust flag; `$csp` filters added as a separate policy instead of
  merged into the site's; stand-ins served only under a per-launch `potato-res://` path; one
  failing list download no longer holds back the others; per-tab counts start at commit.

Open items: Google sign-in check with a real account, extensions. (Cookie encryption: done in
0.8.0.)

## Passwords (0.6.0)

Most people switching browsers depend on saved passwords, and without extensions there is no
password manager extension to fall back on. So: saving and autofill backed by the macOS Keychain,
and CSV import from Chrome (Edge, Brave, Arc), Safari, Firefox and 1Password.

Decisions (2026-11-08):

- **Keychain**: Electron's `safeStorage` (Chromium's OSCrypt), as Chrome does: one random key in
  the login Keychain ("Potato Browser Safe Storage"), passwords and notes encrypted with it in a
  `logins` table of the profile database. Considered instead: one Keychain item per password
  through a bundled Swift helper. It would list passwords in Keychain Access, but adds a signed
  helper binary per architecture, puts hundreds of items in the user's keychain after an import,
  asks once per item after every rebuild of an ad-hoc signed app, and any process could run the
  helper to read them (its signature is what the Keychain trusts). With safeStorage the Keychain
  trusts the app itself, Developer ID releases keep access across updates, and a build from
  source asks once. Websites and usernames are stored readable, so matching never touches the
  Keychain; existing users see no Keychain prompt until they save or fill a password. Checked on
  this Mac: the async API creates and reads the item in the real login keychain; tests run with
  `--use-mock-keychain`, which keeps the key stable across restarts.
- **Dropdown in the browser, not the page**: a per-window WebContentsView under the field
  (positioned from the field's rect, through parent frames by postMessage for cross-origin
  iframes; a parent answers only for the frame that has focus). It opens only when the user
  clicks or tabs into a field, never on a page's `focus()`. Pages cannot read it or forge clicks
  on it (keys only count when `isTrusted`), and picks in the first 500 ms after it appears or
  moves are ignored, as in Chrome, so a page cannot slide it under the pointer. Nothing is
  filled on page load; the password goes to the frame only after a pick, and only if the
  frame's origin (from the browser) matches.
- **Matching**: exact origin; http saved, https page; other hosts of the same registrable domain
  (tldts with private suffixes, so github.io neighbours never share), shown with their host.
  Never https passwords on http pages, nothing on pages past a certificate warning.
- **Saving**: the preload reports submits (form submit, Enter, sign-in buttons, not show-password
  toggles), kept per origin so another frame cannot replace them; the prompt appears once a page
  loads without a password field (a returning sign-in form means a wrong password), or the field
  stays away for 2 s without a page load (single page apps), and is taken back if the field
  returns within 5 s. Usernames from a first step (email, then password) carry over within a
  site. Change-password forms update the saved login whose password matches the current one;
  two different passwords without autocomplete hints (password and PIN?) are not guessed at.
  Never in private windows (they still fill).
- **Import**: header-driven CSV parser (any column order; Chrome, Safari, Firefox, 1Password,
  Bitwarden and LastPass headers), skips app entries, rows without a password or website and
  1Password's archive, never overwrites a saved login. The file is chosen in a native dialog in
  the main process, and the page offers to move it to the Trash afterwards. Export writes
  Chrome's format, owner-only. Only potato://passwords may call the `passwords.*` API (settings
  gets the count). Showing, copying and exporting ask for Touch ID, or the Mac's password where
  there is none (Electron's prompt uses the user-presence access control).

Status (2026-11-08): done. 14 unit tests (CSV formats and quoting, origin matching including
shared hosts, password picking for login/sign-up/change forms, encrypted store, import rules) and
6 e2e tests on fixture sites: save after a form post, fill by click and keyboard with framework
input events, cross-origin iframe fill and placement, a page's own scripts and a too-early click
getting nothing, http pages getting nothing, no prompt after a failed sign-in, single page app
and two-step sign-ins, a single page app failing slowly (prompt taken back), update after a
change, "Never for this site", private windows, internal pages other than the passwords page
denied, and the import of all four formats, edit, delete, export and a restart, on the dev build
and the packaged app. Found on the way: the test proxy dropped form posts (Origin header and
streamed bodies in `net.fetch`), and focus moving into an iframe looked like the page getting
focus back. An independent review before release led to: the dropdown opens only on the user's
click or Tab, picks are ignored right after it moves (not only after it appears), the Enter key
gets the same delay, the passwords API is limited to its page, the Mac password stands in for
Touch ID, single page apps must keep the form away for 2 s, password-and-PIN forms are not read
as a change, pending sign-ins are per origin, bare hosts with ports import, and the mock
Keychain is used only with a test profile.

## In-app updates (0.7.0)

Until 0.6.0 the browser only put a dot on the menu button and linked to the DMG, so a Chromium
security fix reached people when they got around to downloading it. Browsers stay open for weeks,
so fixes have to install themselves within days.

Decisions (2026-11-08):

- **electron-updater with Squirrel.Mac**, the standard for Electron on the Mac. The release
  workflow builds a zip per architecture next to the DMG (Squirrel installs zips only), with
  blockmaps so later updates can download only what changed. The DMG stays for first installs.
- **Feed on potatobrowser.com**, not electron-updater's GitHub provider: the Worker builds
  `latest-mac.yml` (as JSON, which is YAML) from the release's `latest.json`, which now lists the
  zips with size and SHA-512. The browser keeps asking one host, the feed is validated like the
  download page (names, arch, hash format), and a release can be held back at the Worker. The
  zips download from the GitHub Release, one range per request (GitHub does not answer
  multi-range requests, which differential downloads otherwise use).
- **One feed per architecture** (`/api/v1/update/mac/arm64` and `/x64`), chosen by the app from
  `process.arch` (Intel builds under Rosetta get the Apple silicon one): given both zips,
  electron-updater decides by looking for "ARM" anywhere in `uname -a`, host name included, and
  an Intel Mac named that way would install a build it cannot run.
- **Trust**: electron-updater checks the zip's SHA-512 from the feed; Squirrel.Mac then installs
  only an app whose signature satisfies the running app's designated requirement (our Developer
  ID team and bundle id), and the release workflow checks every new app against that requirement.
  A compromised feed or download host cannot install code we did not sign. electron-updater
  refuses versions that are not newer, but it takes the version from the feed: whoever controls
  the Worker could offer an older signed release under a new number.
- **Privacy**: electron-updater sends a random per-install `x-user-staging-id` with every check
  for staged rollouts; the browser strips it in the updater's session. Checks carry no id.
- **When**: 10 s after launch, then every 4 hours. The download starts at once; when Squirrel has
  staged it, "Restart to update" shows in the toolbar (and the menus). One click saves the
  session before the windows close (Squirrel closes them before `before-quit`, so the session is
  saved on `before-quit-for-update`) and the next launch restores it whatever the startup setting.
  Quitting installs a staged update without relaunching. Active downloads ask first. While an
  update waits for the restart there are no further checks; the launch after it checks again.
  If the restart fails after the windows closed, they reopen and the browser carries on.
- **Who**: only Developer ID builds (`__AUTO_UPDATE__`, set when `CSC_LINK` signs the build) in
  an Applications folder download updates. Squirrel would reject an update for an ad-hoc or
  otherwise signed copy after downloading it, and cannot replace an app on the DMG or a
  translocated one; those copies show the version with a Download link, as before. A failed or
  stalled download (no progress for 5 minutes) retries after 15 minutes; an update Squirrel
  refuses twice in one run stops downloading until relaunch.
- **Homebrew**: the cask is `auto_updates true`. Homebrew still upgrades it when the installed
  bundle is older than the tap (the default in Homebrew 7), so 0.6.0 installs move to 0.7.0 with a
  plain `brew upgrade`, and self-updated ones are left alone.

Status (2026-11-08): done. 3 Worker tests (a feed per architecture, swapped or malformed zips
refused, no feed for releases without zips) and 2 e2e tests (the toolbar button restarting into
the update with the tabs back although startup is set to a new tab, and the About states). End to
end on this Mac with two builds signed by one identity with the hardened runtime, a local feed
and a 302 to a CDN as GitHub does: 0.7.0 found 0.7.1 10 s after launch and had it staged at 15 s;
one click restarted into 0.7.1 within 5 s with both windows and all three tabs; quitting instead
installed it without relaunching; an ad-hoc signed 0.7.1 was refused by Squirrel ("code failed
to satisfy specified code requirement(s)"), About offered the download and 0.7.0 stayed; the
staging id never reached the server. Found on the way: Squirrel closes the windows before
`before-quit`, so without `before-quit-for-update` only the last window survived. An independent
review before release led to: a feed per architecture, failure counting limited to updates
Squirrel refuses (a download broken off by sleep retries after 15 minutes instead), a watchdog
for stalled downloads (electron-updater's timeout never fires with Electron's net module), the
windows reopening if a restart fails, single-range downloads from GitHub, and the release check
pinned to the designated requirement of released apps.

## iOS app (plan, 2026-11-07)

Goal: Potato Browser for iPhone (and iPad) on TestFlight with the same four features as the Mac
app: AI Shield, no AI in the engine, the ad blocker and community flags, inside a complete
browser.

Constraints that shape it:

- **WebKit, not Chromium.** Outside the EU and Japan every iOS browser must use WebKit, and even
  there Electron does not run on iOS. The app is native Swift (SwiftUI) around `WKWebView`.
- **Reused as is**: the in-page code (`apps/browser/src/content`: shield rules and engine, flag
  engine and adapters, ad blocker cosmetics), `packages/shared` and the Worker. It is bundled
  with esbuild and injected as `WKUserScript`s.
- **No synchronous IPC.** WKWebView has async messages only, so the per-page config (which the
  Mac preload reads with `sendSync`) is computed in `decidePolicyFor navigationAction` and
  installed as a document-start user script before the navigation proceeds. Each tab has its own
  `WKUserContentController` for that.
- **No request hook.** Network blocking goes through `WKContentRuleList`s (WebKit's content
  blocker), compiled on the device from rules converted at build time.

Design:

- **AI Shield**: the content world script runs `ShieldEngine` unchanged. Its CSS goes into a
  `<style>` at document start (no public user stylesheet API on iOS). The rules' blocked AI
  request paths become a small rule list built at runtime; Google AI Mode redirects and the AI
  chatbot block happen in the navigation policy.
- **No AI in the engine**: WebKit has no switches, so: Writing Tools off
  (`writingToolsBehavior = .none`), inline predictions off, Genmoji off, no speech recognition
  usage description (WebKit then denies `SpeechRecognition`), and a page world document-start
  script deletes the AI globals in every frame. Settings runs the Mac app's purity check
  (`FORBIDDEN_GLOBALS`, window and worker) on the device and shows the result.
- **Ad blocker**: a build step converts the pinned lists (filters/lock.json) per group (ads,
  trackers, cookie notices, annoyances) into WebKit rule lists: `block` for network filters,
  exceptions as `ignore-previous-rules`. Groups are separate lists, so a settings change adds or
  removes a list instead of recompiling. Cosmetics, scriptlets and procedural selectors come from the same
  Ghostery engine as on the Mac, run in JavaScriptCore inside the app: per navigation it gives the
  page's styles and scriptlets (scriptlets run as page world user scripts, before page scripts),
  and it answers the generic rules for ids and classes as the page changes. Ads allowed on a
  site: that tab's controller drops the lists for the navigation. Daily list updates and the
  user's own filters reuse the converter and the engine in JavaScriptCore.
- **Flags**: the flag engine and adapters run in the content world; lookups and votes go through
  native code (CryptoKit SHA-256, URLSession) with the same k-anonymity protocol. Private tabs
  vote under a throwaway id and keep their flags in memory.
- **Browser**: tabs and private tabs (non-persistent data store), address bar with history,
  bookmark and search suggestions, back/forward gestures, tab switcher, reopen closed tab,
  session restore, bookmarks (folders), history, downloads (`WKDownload`, visible in Files),
  find in page, share and print, page zoom, desktop site, context menus, popups and OAuth
  windows, JavaScript dialogs, permissions, error pages, new tab page with today's counts,
  first-run setup, settings like the Mac app's, and import of bookmarks HTML and Safari's export.

Verification:

- vitest for the converter (WebKit's regex subset is checked per rule) and the bridge.
- XCTest in the simulator: every bundled rule list compiles in WebKit, URL classification (the
  Mac app's cases), settings, database, flag hashing against `@potato/shared`.
- An end-to-end run on the simulator against the Mac app's fixture sites, served under their
  real hostnames through a local proxy (`WKWebsiteDataStore.proxyConfigurations`) with a test CA,
  and the real flags Worker under `wrangler dev`: shield, ad blocker, flags, engine purity.
- Live checks on the simulator (Google, YouTube, Reddit, news sites, adblock-tester.com) with
  screenshots, and a UI smoke test of the main flows.

Release: bundle id `com.potatobrowser.app` (as on the Mac), `apps/ios/scripts/testflight.sh`
archives with automatic signing through the App Store Connect API key, uploads, and adds the
team to an internal TestFlight group. Builds are numbered by commit count.

Findings of the WebKit spike (iOS 27 simulator):

- App rule lists compile with up to 150,000 rules each; one url-filter outside WebKit's regex
  subset fails the whole list, so the converter checks every pattern (`isWebKitRegex`, after
  WebCore's URLFilterParser). Ads compile in about 10 s and trackers in 7 s, once.
- `redirect` and `modify-headers` actions parse but do nothing outside Safari extensions: no
  uBlock stand-ins, no `$csp`, no `Sec-GPC` header. Redirect filters block instead.
- User scripts and rule lists changed while a main-frame navigation waits for its policy decision
  apply to that navigation.
- iOS 27 WebKit exposes no AI web APIs except `webkitSpeechRecognition`, which fails with
  `not-allowed` in an app without a speech recognition usage description; nothing in workers.
- The Ghostery engine in JavaScriptCore without JIT (as on a device) loads ads and trackers in
  0.3 s and 0.2 s and answers a page's cosmetics in 1 to 12 ms.

## iOS status (2026-11-07)

- `apps/ios`: SwiftUI app, 0.5.0, on TestFlight (internal group "Team").
- Tests: 30 vitest (converter, parity with the Mac app), 20 XCTest units, 4 UI tests and 136
  end-to-end checks on the simulator against the Mac app's fixture sites and the real Worker,
  all passing.
- Live checks on the simulator: adblock-tester.com 100/100; Google search on the mobile layout
  with 4 AI features hidden and AI Mode sent back to results; m.youtube.com with uBlock's
  scriptlets stripping the ad data from the player response and flag buttons on every video;
  Reddit with flag buttons on every post; consent walls gone with cookie notices on.
- Found on the way: a WKWebView made before the app has a window crashes on its first tap
  (UIKit gesture handling), so tab web views are made when first shown; typed URLs with escapes
  were escaped twice.

Open items (iOS): the default browser entitlement (requested from Apple), mobile layouts of the
logged-in social sites, iPad multiwindow. (Vote buckets for phones: decided in 0.8.0, see
Launch work.)

## Launch work (0.8.0 for Mac, 0.6.0 for iOS, 2026-11-08)

From the launch list: ways to hear from users (site reports, crash reports, install counts),
rule fixes without a release, disputes for wrongly flagged posts, and hardening.

Decisions:

- **Not AI votes.** A vote is `ai` or `human`, one per install and post (changing your mind keeps
  the network the vote was first cast from), counted per network bucket like flags. A post
  counts as AI-generated when AI flags minus Not AI votes reach the threshold; your own vote
  always decides for you. One for one is easy to explain and makes brigading a human post as AI
  cost as much as defending it. Apps before 0.8.0 only know flags: lookups without `v: 2` get
  the net count, so disputes work for them from the day the Worker ships.
- **Vote buckets on phones: no special rule.** A vote still counts once per IPv4 /24 or IPv6 /48,
  on phones as on Macs. iPhones on the big carriers reach potatobrowser.com over IPv6 (Cloudflare
  answers AAAA, iOS prefers it, carriers such as T-Mobile US are IPv6-only with 464XLAT), where
  each phone has its own /64 and carriers spread them over many /48s; the IPv4 carrier NAT
  collapse applies only on IPv4-only carriers, and phones browse mostly on Wi-Fi anyway. Any finer
  bucket for carrier networks (an IPv6 /64, an IPv4 address) is re-rolled by toggling airplane
  mode, which would let one person reach the default threshold of 3 within a minute; telling
  carriers apart by ASN needs a list to maintain and leaves the same hole. Collapsing errs towards
  fewer flags, so a post stays visible rather than buried by one person. Instead the Worker
  measures it: `vote_stats` counts per day, app and IP family the votes that added a network to a
  post and the ones whose network already counted ("collapsed"), shown on `/admin`. If phones
  show a high collapsed share once the iOS app is public, the next step is App Attest for iOS
  votes: one vote per genuine device, no accounts, and no IP rule for attested votes.
- **Install counts from the daily check.** The filter list check runs once per calendar day (UTC)
  instead of every 24 hours and adds `app`, `v` and `daily=1`; the Worker increments
  `installs(day, app, version)`. "Update now" leaves out `daily=1`, so it is not counted twice. No id, so a day's count is the installs that ran that day with updates on. Checks
  from older apps count as `legacy`, their app told apart by the HTTP client (CFNetwork or a Mac
  Chrome user agent).
- **AI Shield rules from the site, signed.** The rules are data, but they inject CSS into every
  page, so a server that could change them could hide anything or, with raw CSS, read form
  values through `url()`. The payload is signed with Ed25519 at deploy time by a key that lives
  only on the deploying machine (`~/.config/potatobrowser/shield-rules-ed25519.pem` on devserver;
  back it up), and the apps also validate every field; the deploy refuses rules that fail the
  validator. The version lives in `rules.lock.json` with the hash it was bumped for (`--bump`
  sets it to the time, always above the last), so the apps and the site agree on it whatever
  clone they are built from; a unit test, release builds and the deploy refuse a stale lock. (A
  first version used git commit times, which a shallow release checkout or a merge with an older
  commit date can order wrongly.) The hash decides whether anything changed. The Mac main process sends each frame its host's
  rules in the page config; iOS adds the catalog as a content world script for the pages.
- **Site reports** carry the page address without the fragment, the choice, the app and version
  (the version tells whether a report predates a fix). Triage happens on `/admin` (Basic auth,
  `ADMIN_TOKEN`), which can also mark every report of a host done. A daily cron deletes triaged
  reports after 30 days and all after 90.
- **Crash reports, opt-in.** Off by default; until switched on Crashpad never starts, so nothing
  is written even locally. Minidumps can contain page content, which is why it is opt-in and the
  welcome page says so. R2 keeps them 90 days (lifecycle rule plus the cron); the Worker zeroes
  Crashpad's per-install client id, in the form and in the dump's info stream, and refuses posts
  with browser headers, since a multipart form needs no CORS preflight. On iOS, MetricKit delivers crash and hang diagnostics on the next
  launch; the app strips region and pid before sending.
- **Cookie encryption.** The `enableCookieEncryption` fuse is on: cookies use the same Keychain
  key as saved passwords. Checked with two packaged builds on one profile, with the mock and the
  real login Keychain: plain cookies from 0.7 stay readable, new ones are written as `v10`
  ciphertext and read back after a relaunch, and a password saved by 0.7 still decrypts. A
  downgrade to 0.7 drops the encrypted cookies (sites sign you out); Squirrel never downgrades.
- **iOS hiding rules outrank site CSS.** Adopted sheets are author CSS, so a site's own
  `!important` with a more specific selector won (DuckDuckGo's mobile Duck.ai button). The
  shield's rules get three never-matching id tests, which only raises their specificity.
- **Passkeys stay out of reach on the Mac.** Electron 45 reports no user-verifying platform
  authenticator, and a passkey request waits with no UI until it times out (checked against
  webauthn.io and a plain page). The FAQ and README say so; hardware keys are untested.
- **Widevine waits for castlabs.** castlabs' Electron for Content Security has 45.2.1 at most,
  while 45.2.2 and 45.2.3 carry Chromium security backports and the fix for removing user
  stylesheets that the AI Shield relies on. Switching now would roll those back.

Also: the iOS app no longer declares `NSAllowsLocalNetworking` (the e2e run talks to 127.0.0.1,
which ATS allows anyway), its privacy manifest lists what reaches the service, the App Store and
TestFlight texts live in `apps/ios/store` with `asc.mjs` commands to upload them, CI runs the
XCTest units on GitHub's `xcode-27` image, and srv-deploy uploads a TestFlight build when the
iOS app or what it bundles changes on main.

An independent review of the launch work before release led to: rule versions from a lock file
instead of git times, Crashpad's client id zeroed inside the dump too, CSS comment tokens refused
in rule selectors and raw CSS, crash uploads with browser headers refused, only the scheduled
check counted, and rules validated before they are signed.
