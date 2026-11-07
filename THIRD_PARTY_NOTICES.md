# Third-party notices

## Stevo's AI Blocklist

Several AI Shield selectors in `apps/browser/src/content/shield/rules.ts` were informed by
Stevo's AI Blocklist (https://github.com/Stevoisiak/Stevos-AI-Blocklist).

MIT License

Copyright (c) 2026 Stevoisiak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Ad blocker engine

The ad blocker runs on [@ghostery/adblocker](https://github.com/ghostery/adblocker) and its
companion packages, bundled into the app's JavaScript unmodified:

- @ghostery/adblocker, @ghostery/adblocker-content, @ghostery/adblocker-extended-selectors,
  @ghostery/url-parser (Copyright (c) 2017-present Ghostery GmbH)
- @remusao/guess-url-type, @remusao/small, @remusao/smaz, @remusao/smaz-compress,
  @remusao/smaz-decompress, @remusao/trie (Copyright (c) Rémi Berson)

They are licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/). Their
source code is available at https://github.com/ghostery/adblocker and https://github.com/remusao
and on npm under the same names and versions as in `pnpm-lock.yaml`.

`apps/browser/src/content/adblock/cosmetics.ts` is modeled on
@ghostery/adblocker-webextension-cosmetics (MPL-2.0).

tldts and tldts-core (https://github.com/remusao/tldts): MIT License, Copyright (c) 2017 Thomas
Parisot, 2018 Rémi Berson, under the same MIT license text as Stevo's AI Blocklist above.

## Filter lists and scriptlets

The app ships, and downloads updates of, these lists unmodified from Ghostery's CDN
(`Potato Browser.app/Contents/Resources/app.asar`, `dist/filters/lists`, gzipped; the compiled
`engine.bin` next to them is built from the same files):

- EasyList, EasyPrivacy and EasyList Cookie (https://easylist.to/), dual licensed under the GNU
  General Public License version 3 or later and Creative Commons Attribution-ShareAlike 3.0
  (https://easylist.to/pages/licence.html).
- uBlock Origin's filter lists (https://github.com/uBlockOrigin/uAssets), GNU General Public License
  version 3.
- uBlock Origin's scriptlets and redirect resources (https://github.com/gorhill/uBlock), GNU
  General Public License version 3, in the packaging of @ghostery/adblocker (`resources.json`).

These files are separate works distributed alongside the browser, not part of its MIT-licensed
code. Their exact revisions and SHA-256 hashes are listed in `apps/browser/filters/lock.json`.

## Chromium and Electron

The browser is built on Electron, which bundles Chromium. Their licenses ship inside the app
(`LICENSE` and `LICENSES.chromium.html` in the application bundle).
