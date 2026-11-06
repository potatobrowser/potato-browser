# Contributing

Thanks for helping keep the web human. The most useful contributions are usually small:

- **An AI feature is still showing** on a site. Open an issue with the URL, a screenshot and,
  if you can, the element in the inspector (View, Developer, Developer Tools). Or fix the rule in
  `apps/browser/src/content/shield/rules.ts` yourself.
- **A flag button is missing or on the wrong post.** The platform adapters are in
  `apps/browser/src/content/flags/adapters`.
- **A browser bug.** Issues with steps to reproduce are best; pull requests are welcome.

For security problems, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

See [Build it yourself](README.md#build-it-yourself) in the README. For development:

```sh
pnpm install
pnpm --filter @potato/browser dev        # build and start the browser
pnpm --filter @potato/web dev            # site and flags API on localhost:8787
```

## Before you open a pull request

```sh
pnpm typecheck
pnpm test                                # unit tests for shared, web and browser
pnpm --filter @potato/browser test:e2e   # end-to-end tests against the real app
```

CI runs the same on every pull request.

- **Shield rules**: add or update a fixture under `apps/browser/test/fixtures/sites/<host>/`
  with the smallest markup that reproduces the feature, and an assertion in
  `apps/browser/test/e2e/shield.spec.ts`. An e2e test checks that every selector is valid in the
  shipped Chromium.
- **User-facing copy**: plain ASCII punctuation (no em or en dashes, no curly quotes), short
  sentences, and a light potato voice where it fits.
- **Privacy**: nothing the user reads may leave the machine. Flag lookups send hash prefixes only.
  If a change sends anything new over the network, say so in the pull request.

## How changes land

Development happens in the maintainer's working repository, and its `main` is mirrored here.
Pull requests are reviewed and merged here as usual; the merge is then pulled into the working
repository, so it stays in `main` with its authorship.

Releases are cut by bumping `version` in `apps/browser/package.json` and adding a
`## <version>` section to [CHANGELOG.md](CHANGELOG.md). The mirror then tags `v<version>`, and
the [release workflow](.github/workflows/release.yml) builds and publishes it.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
