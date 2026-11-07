# Potato Browser

A Chromium-based browser for macOS for people who want the web without AI, and without ads. Grown,
not generated.

- **AI Shield**: the AI features of major sites (Google AI Overviews and AI Mode, Gemini in Gmail
  and Docs, YouTube Ask, Bing and Outlook Copilot, X Grok, Meta AI, LinkedIn AI writing, Reddit
  Answers, Amazon Rufus and more) are hidden by default. The shield button in the toolbar turns
  them back on for one site.
- **No AI in the engine**: no on-device models, no AI browser features, and Chromium's built-in AI
  web APIs (Prompt, Summarizer, Writer, Rewriter, Proofreader, Translator, Language Detector,
  speech recognition, WebNN) are switched off for every page and worker.
- **Ad blocker**: ads, video ads, pop-ups and trackers are blocked by default, with the EasyList,
  EasyPrivacy and uBlock Origin lists (network filters, cosmetic filters and scriptlets, which
  keep video ads off YouTube). The ad blocker button in the toolbar lets ads through on one site.
  Cookie notices and annoyances can be hidden too.
- **Community AI flags**: anonymous "AI?" flags on Reddit, X, Instagram, Facebook, Threads,
  LinkedIn, YouTube, Bluesky and TikTok posts. Flagged posts are hidden, labelled or left alone,
  as the user chooses.

Website: https://potatobrowser.com. Free and open source under the [MIT license](LICENSE).

## Install

With [Homebrew](https://brew.sh):

```sh
brew install --cask potatobrowser/tap/potato-browser
```

Or get the DMG for Apple Silicon or Intel from https://potatobrowser.com or from
[Releases](https://github.com/potatobrowser/potato-browser/releases). It needs macOS 13 Ventura or
later.

Every release is built by [GitHub Actions](.github/workflows/release.yml) from the tagged commit
in this repository, so the build log is public. Releases are signed with an Apple Developer ID and
notarized by Apple, so macOS opens them like any other app.

### Verify a download

Each release has a `SHA256SUMS` file and a signed build provenance attestation that ties each DMG
to the workflow run and the commit it was built from:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify Potato-Browser-0.4.2-arm64.dmg --repo potatobrowser/potato-browser
spctl --assess -vv "/Applications/Potato Browser.app"   # source=Notarized Developer ID
```

## Build it yourself

You need a Mac with macOS 13 or later, [Node.js](https://nodejs.org) 22 or later, git, and pnpm 12
(`npm install -g pnpm@12`).

```sh
git clone https://github.com/potatobrowser/potato-browser
cd potato-browser
git checkout v0.4.2                                   # optional: a released version
pnpm install
pnpm --filter @potato/browser dist --arch host        # DMG for this Mac
open apps/browser/release
```

`--arch arm64` or `--arch x64` picks the architecture; without `--arch` it builds both, as the
release does. Your build is ad-hoc signed instead of Developer ID signed, but it is not
quarantined, so it opens without a warning too. To run the browser without packaging it, use
`pnpm --filter @potato/browser dev`.

Your build uses the public flags service at potatobrowser.com. To point it at your own (see
[The site and flags service](#the-site-and-flags-service)), set `POTATO_API_BASE_BUILD` when
building:

```sh
POTATO_API_BASE_BUILD=https://flags.example.com pnpm --filter @potato/browser dist --arch host
```

## Repository

```
apps/browser      Electron 45 (Chromium 156) app
  src/main          windows, tabs, sessions, SQLite profile, importers, flags client, ad blocker
  src/preload       ui.ts (browser chrome), web.ts (every tab frame)
  src/content       AI Shield rules and engine, ad blocker cosmetics, flag engine and adapters
  filters           ad blocker list catalog (lists.json) and pinned revisions (lock.json)
  src/renderer      React UI: browser chrome and internal potato:// pages
  test/unit         vitest
  test/e2e          Playwright against the real app, offline fixture sites, real Worker
  test/live         manual checks against live websites
apps/web          Cloudflare Worker: landing page, flags API (D1), filter lists, releases, downloads
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
`node test/live/adblock-check.mjs <screenshot-dir> --compare <url...>` does the same for the ad
blocker, with it on and off.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes and releases land.

## Releases

1. Bump `version` in `apps/browser/package.json` and add a `## <version>` section to
   [CHANGELOG.md](CHANGELOG.md). Refresh the bundled filter lists with
   `node apps/browser/scripts/filters.mjs update`.
2. Push the tag `v<version>`. The [release workflow](.github/workflows/release.yml) runs the
   tests, builds both DMGs on a GitHub macOS runner, signs them with the Developer ID, has Apple
   notarize the apps and the DMGs, checks that Gatekeeper accepts them and that the app starts,
   writes `latest.json` and `SHA256SUMS`, attests the build, publishes the GitHub Release with the
   changelog section as notes, and updates the cask in
   [potatobrowser/homebrew-tap](https://github.com/potatobrowser/homebrew-tap).

potatobrowser.com reads `latest.json` from the latest release to show the version and checksums,
and `/download/mac-arm64` and `/download/mac-x64` redirect to that release's DMGs. The app's
daily update check asks the same endpoint and never downloads anything itself.

The workflow reads its secrets from the `release` environment, which only `v*` tags can use:
`MAC_CERT_P12` (the Developer ID Application certificate as a base64 .p12), `MAC_CERT_PASSWORD`,
`APPLE_API_KEY` (an App Store Connect .p8 key), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
`TAP_DEPLOY_KEY` (a deploy key that can write to the tap). Builds without `CSC_LINK`, such as a
build from source, are ad-hoc signed.

## The site and flags service

`apps/web` is one Cloudflare Worker: the landing page (static assets), the flags API on D1, the
ad blocker's filter list updates (proxied from Ghostery's CDN and cached at the edge), and release
info read from this repository's GitHub Releases (`SOURCE_REPO` in `wrangler.jsonc`).
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
- **Ad blocker** (`apps/browser/src/main/adblock`) runs
  [@ghostery/adblocker](https://github.com/ghostery/adblocker) on EasyList, EasyPrivacy and uBlock
  Origin's lists from Ghostery's CDN. `filters/lock.json` pins each list's revision and SHA-256; the
  build downloads exactly those files, compiles the default engine into the app (it loads in about
  20 ms) and ships the lists for other choices. Every subresource request goes through the
  engine in the session's `onBeforeRequest` (main frames never), and blocked scripts that pages
  depend on are swapped for uBlock's harmless stand-ins, served from `potato-res://` since
  Chromium will not follow a redirect to a `data:` URL. The web preload asks for each frame's
  cosmetic filters and scriptlets synchronously at document start, inserts the styles as user
  stylesheets and runs the scriptlets in the page before its own scripts, then applies generic
  and procedural rules as the page changes. Once a day the browser asks the Worker for the
  latest list revisions and downloads changed lists through it (`/api/v1/filters`), recompiles
  them in a utility process and swaps the engine without a restart. Scriptlet code is never
  downloaded: it changes only with a release. As in uBlock Origin, only uBlock's own lists and
  the user's filters may call "trusted" scriptlets (the ones whose arguments can carry code);
  `$csp` filters add a separate policy and never loosen the site's own.
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
- The ad blocker filters subresources and page elements; it does not block whole pages (uBlock's
  "strict blocking" of known bad sites) and ignores `$removeparam` filters.
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
