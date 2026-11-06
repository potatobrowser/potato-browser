#!/usr/bin/env bash
# Mirrors main to the public repository and tags each new app version there; the tag starts the
# public release build (.github/workflows/release.yml). Run by srv-deploy (deploy.json) after
# every push to main of the development repository.
set -euo pipefail

PUBLIC="${PUBLIC_REPO:-git@github.com:potatobrowser/potato-browser.git}"
sha="${DEPLOY_SHA:-$(git rev-parse HEAD)}"
version=$(git show "$sha:apps/browser/package.json" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)')

# Plain push: if the public main has commits this one lacks (a merged pull request), this fails
# until they are pulled into the development repository.
git push "$PUBLIC" "$sha:refs/heads/main"

if git ls-remote --exit-code --tags "$PUBLIC" "refs/tags/v$version" >/dev/null; then
  echo "v$version is already tagged"
else
  git push "$PUBLIC" "$sha:refs/tags/v$version"
  echo "tagged v$version at $sha; the release workflow builds it now"
fi
