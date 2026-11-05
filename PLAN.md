# No-AI Browser: MVP plan

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
  src/preload     ui.ts (browser chrome), web.ts (every tab frame: shield + flags + noai:// pages API)
  src/content     in-page engines: shield rules + heuristics, flag adapters + injected UI
  src/renderer    React UI: chrome (tab strip, toolbar, popovers) and internal noai:// pages
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

- Only an Apple Development certificate is available, so builds are ad-hoc signed and not
  notarized. The landing page explains the one-time "Open Anyway" step. Notarization needs a
  Developer ID Application certificate.
