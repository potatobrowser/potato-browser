# Potato Browser

A Chromium-based browser for macOS for people who want the web without AI. Grown, not generated.

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

Website: https://potatobrowser.com. Free and open source under the [MIT license](LICENSE).

## Download

Get the DMG for Apple Silicon or Intel from https://potatobrowser.com or from
[Releases](https://github.com/potatobrowser/potato-browser/releases). It needs macOS 13 Ventura or
later.

Every release is built by [GitHub Actions](.github/workflows/release.yml) from the tagged commit
in this repository, so the build log is public. The builds are ad-hoc signed and not notarized
yet, so macOS asks once: open the app, then System Settings, Privacy & Security, Open Anyway.

### Verify a download

Each release has a `SHA256SUMS` file and a signed build provenance attestation that ties each DMG
to the workflow run and the commit it was built from:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify Potato-Browser-0.4.0-arm64.dmg --repo potatobrowser/potato-browser
```

## Build it yourself

You need a Mac with macOS 13 or later, [Node.js](https://nodejs.org) 22 or later, git, and pnpm 12
(`npm install -g pnpm@12`).

```sh
git clone https://github.com/potatobrowser/potato-browser
cd potato-browser
git checkout v0.4.0                                   # optional: a released version
pnpm install
pnpm --filter @potato/browser dist --arch host        # DMG for this Mac
open apps/browser/release
```

`--arch arm64` or `--arch x64` picks the architecture; without `--arch` it builds both, as the
release does. An app you build yourself is not quarantined, so it opens without the Open Anyway
step. To run the browser without packaging it, use `pnpm --filter @potato/browser dev`.

Your build uses the public flags service at potatobrowser.com. To point it at your own (see
[The site and flags service](#the-site-and-flags-service)), set `POTATO_API_BASE_BUILD` when
building:

```sh
POTATO_API_BASE_BUILD=https://flags.example.com pnpm --filter @potato/browser dist --arch host
```

## Repository

```
apps/browser      Electron 45 (Chromium 156) app
  src/main          windows, tabs, sessions, SQLite profile, importers, flags client, menus
  src/preload       ui.ts (browser chrome), web.ts (every tab frame)
  src/content       AI Shield rules and engine, flag engine and platform adapters
  src/renderer      React UI: browser chrome and internal potato:// pages
  test/unit         vitest
  test/e2e          Playwright against the real app, offline fixture sites, real Worker
  test/live         manual checks against live websites
apps/web          Cloudflare Worker: landing page, flags API (D1), release info and downloads
packages/shared   flag key format, hashing, API types
```

## Develop and test

```sh
pnpm install
pnpm --filter @potato/browser dev        # build and start the browser
pnpm --filter @potato/web dev            # Worker and landing page on localhost:8787

pnpm typecheck
pnpm test                                # unit tests: shared, Worker (in workerd), browser
pnpm --filter @potato/browser test:e2e   # end-to-end tests against the real app
```

The e2e suite builds the app, serves fixture copies of real sites under their real hostnames
(Google, Gmail, YouTube, Reddit, X, Facebook, Instagram, LinkedIn and others) through a test-only
proxy, and runs the real flags Worker under `wrangler dev` with a local D1.

To run the same suite against a packaged app:

```sh
cd apps/browser
node scripts/dist.mjs --test
POTATO_E2E_EXECUTABLE="$PWD/release/test/mac-arm64/Potato Browser.app/Contents/MacOS/Potato Browser" \
  POTATO_E2E_SKIP_BUILD=1 npx playwright test
```

`node test/live/live-check.mjs <screenshot-dir> <url...>` opens real sites in the real browser and
prints what the shield hid and how many flag buttons were placed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes and releases land.

## Releases

1. Bump `version` in `apps/browser/package.json` and add a `## <version>` section to
   [CHANGELOG.md](CHANGELOG.md).
2. Push the tag `v<version>`. The [release workflow](.github/workflows/release.yml) runs the
   tests, builds both DMGs on a GitHub macOS runner, writes `latest.json` and `SHA256SUMS`,
   attests the build and publishes the GitHub Release with the changelog section as notes.

potatobrowser.com reads `latest.json` from the latest release to show the version and checksums,
and `/download/mac-arm64` and `/download/mac-x64` redirect to that release's DMGs. The app's
daily update check asks the same endpoint and never downloads anything itself.

With a Developer ID Application certificate, set `mac.identity` and enable notarization in
`apps/browser/electron-builder.config.cjs`.

## The site and flags service

`apps/web` is one Cloudflare Worker: the landing page (static assets), the flags API on D1, and
release info read from this repository's GitHub Releases (`SOURCE_REPO` in `wrangler.jsonc`).
To run your own, create a D1 database, put its id in `wrangler.jsonc`, then:

```sh
cd apps/web
npx wrangler secret put VOTER_SALT       # any long random string, kept forever
pnpm run deploy                          # applies D1 migrations, then wrangler deploy
```

## How it works

- **AI Shield** rules live in `apps/browser/src/content/shield/rules.ts`. Each feature hides
  elements with CSS (injected as a user stylesheet at document start, so nothing flashes) and
  optionally with text or aria-label heuristics, placeholder rewrites, and blocked request
  paths. A unit test checks the catalog, and an e2e test checks every selector is valid in the
  shipped Chromium.
- **Flags** keep what you read on your Mac. Lookups send only 5-character prefixes of
  `sha256("noai-flag:v1:<platform>:<id>")`, each shared by many posts; the browser matches full
  hashes locally. A flag sends the full hash and a random install id (a throwaway one in private
  windows), which the Worker stores only as an HMAC, plus a 16-bit keyed bucket of the network
  prefix (IPv4 /24, IPv6 /48) and the hour. Counts are distinct buckets, so one connection cannot
  stuff votes with made-up install ids. The Worker keeps no IPs or URLs; rate limits are per IP
  (IPv6 per /64) and not persisted. The flag button lives in a closed shadow root and ignores
  clicks that page scripts synthesize.
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

## Former name

The project was called No-AI Browser until 0.2.0. Some identifiers keep that name on purpose:

- the `noaibrowser` Worker (its `VOTER_SALT` secret cannot be copied to a new Worker) and the
  `noaibrowser` D1 database. The Worker serves potatobrowser.com; its workers.dev URL stays up
  because builds before 0.3.0 call the API there, and its pages redirect to potatobrowser.com;
- the flag hash domain `noai-flag:v1:`, since every stored flag is keyed by it.

On first launch, Potato Browser moves an existing `~/Library/Application Support/No-AI Browser`
profile to `Potato Browser`, and saved `noai://` URLs (restored tabs, homepage, bookmarks) open
as `potato://`.

## License

MIT, see [LICENSE](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
