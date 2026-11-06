# No-AI Browser

A Chromium-based browser for macOS for people who want the web without AI.

- **AI Shield**: the AI features of major sites (Google AI Overviews and AI Mode, Gemini in Gmail
  and Docs, YouTube Ask, Bing and Outlook Copilot, X Grok, Meta AI, LinkedIn AI writing, Reddit
  Answers, Amazon Rufus and more) are hidden by default. The shield button in the toolbar turns
  them back on for one site.
- **No AI in the engine**: no on-device models, no AI browser features, and Chromium's built-in AI
  web APIs (Prompt, Summarizer, Writer, Rewriter, Proofreader, Translator, Language Detector,
  speech recognition, WebNN) are switched off for every page and worker.
- **Community AI flags**: anonymous "AI?" flags on Reddit, X, Instagram, Facebook, Threads,
  LinkedIn, YouTube, Bluesky and TikTok posts. Flagged posts are hidden, labelled or left alone,
  as the user chooses.

Website and downloads: https://noaibrowser.laszlo-kiss27.workers.dev

## Repository

```
apps/browser      Electron 45 (Chromium 156) app
  src/main          windows, tabs, sessions, SQLite profile, importers, flags client, menus
  src/preload       ui.ts (browser chrome), web.ts (every tab frame)
  src/content       AI Shield rules and engine, flag engine and platform adapters
  src/renderer      React UI: browser chrome and internal noai:// pages
  test/unit         vitest
  test/e2e          Playwright against the real app, offline fixture sites, real Worker
  test/live         manual checks against live websites
apps/web          Cloudflare Worker: landing page, flags API (D1), downloads (R2)
packages/shared   flag key format, hashing, API types
```

## Develop

Requires macOS, Node 22 and pnpm 12.

```sh
pnpm install
pnpm --filter @noai/browser dev        # build and start the browser
pnpm --filter @noai/web dev            # Worker and landing page on localhost:8787
```

## Test

```sh
pnpm --filter @noai/shared test        # protocol unit tests
pnpm --filter @noai/web test           # Worker API tests in workerd (D1, R2)
pnpm --filter @noai/browser test       # browser unit tests
pnpm --filter @noai/browser test:e2e   # 49 end-to-end tests
```

The e2e suite builds the app, serves fixture copies of real sites under their real hostnames
(Google, Gmail, YouTube, Reddit, X, Facebook, Instagram, LinkedIn and others) through a test-only
proxy, and runs the real flags Worker under `wrangler dev` with a local D1.

To run the same suite against a packaged app:

```sh
cd apps/browser
node scripts/dist.mjs --test
NOAI_E2E_EXECUTABLE="$PWD/release/test/mac-arm64/No-AI Browser.app/Contents/MacOS/No-AI Browser" \
  NOAI_E2E_SKIP_BUILD=1 npx playwright test
```

`node test/live/live-check.mjs <screenshot-dir> <url...>` opens real sites in the real browser and
prints what the shield hid and how many flag buttons were placed.

## Release

1. Bump `version` in `apps/browser/package.json`.
2. `pnpm --filter @noai/browser release` builds both DMGs, uploads them to the
   `noaibrowser-releases` R2 bucket, publishes `latest.json` and checks the live download links.

Builds are ad-hoc signed because only an Apple Development certificate is available. Users
confirm the first launch in System Settings, Privacy & Security, Open Anyway (the website
explains this). With a Developer ID Application certificate, set `mac.identity` and enable
notarization in `apps/browser/electron-builder.config.cjs`.

## Deploy

Pushing `main` deploys `apps/web` through srv-deploy (`deploy.json`): tests, D1 migrations, then
`wrangler deploy`. The Worker secret `VOTER_SALT` is set once with `wrangler secret put`.

## How it works

- **AI Shield** rules live in `apps/browser/src/content/shield/rules.ts`. Each feature hides
  elements with CSS (injected as a user stylesheet at document start, so nothing flashes) and
  optionally with text or aria-label heuristics, placeholder rewrites, and blocked request
  paths. A unit test checks the catalog, and an e2e test checks every selector is valid in the
  shipped Chromium.
- **Flags** never send what you read. Lookups send 5-character prefixes of
  `sha256("noai-flag:v1:<platform>:<id>")`; the browser matches full hashes locally. A flag
  sends the full hash and a random install id, which the Worker stores only as an HMAC, plus a
  16-bit keyed bucket of the network prefix (IPv4 /24, IPv6 /48). Counts are distinct buckets,
  so one connection cannot stuff votes with made-up install ids. The Worker keeps no IPs or
  URLs; rate limits are per IP but not persisted.
- **Platform adapters** (`apps/browser/src/content/flags/adapters`) find posts and their stable
  ids. Facebook and LinkedIn show different ids for one post on different surfaces; flags are
  written to every id found and lookups take the highest count.

## Known limitations

- No extension support and no built-in password manager yet.
- Google account sign-in uses a Firefox user agent on Google's account pages (Google blocks
  sign-in from browsers it can't identify). This has not been verified with a real account.
- Logged-in layouts of X, Facebook, Instagram, LinkedIn and TikTok are covered by fixtures built
  from their current DOM, not by live tests (those pages require an account). Site markup
  changes, so rules and adapters need occasional updates through new releases.
