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

## Status (2026-11-06)

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

Open items: Google sign-in check with a real account, extensions and a password manager,
cookie encryption (possible now that releases are Developer ID signed).
