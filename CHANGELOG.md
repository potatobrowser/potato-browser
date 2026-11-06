# Changelog

Each `## <version>` section becomes the notes of that GitHub Release.

## 0.4.1

- Signed with an Apple Developer ID and notarized by Apple, so macOS opens it like any other app, without the Open Anyway step.
- Install it with Homebrew: brew install --cask potatobrowser/tap/potato-browser.

## 0.4.0

- Potato Browser is open source under the MIT license, at github.com/potatobrowser/potato-browser. Releases are now built in public by GitHub Actions from the tagged source, with SHA-256 checksums and signed build provenance.
- Security: a web page can no longer accept a certificate warning or lift a chatbot block for itself through potato://action links. Only the warning page the browser shows can.
- Security: pages you continued to past a certificate warning keep the "not secure" mark, web pages cannot reach internal pages through redirects, and allowing a site to open one kind of app link no longer allows all of them.
- Security: sites that ask for a client certificate get one only after you pick it, and Web Bluetooth requests are declined instead of connecting the first nearby device.
- AI Shield and flags now also work in tabs opened from links and popups.
- Flags: page scripts can no longer press the AI? button for you or read which posts you flagged.
- Flags: private windows flag under a throwaway id, kept apart from your normal profile.
- Flags: a YouTube video opened from another video gets its own flag button, and posts whose ids load late get buttons too.
- Flags service: stricter request checks stop other websites from flagging through your browser, rate limits cover whole IPv6 networks, and Tor exits cannot flag.
- AI Shield works faster on pages with lots of text, such as Amazon.

## 0.3.0

- The site and the flags API moved to potatobrowser.com. Site and app copy got a light potato voice.

## 0.2.0

- Renamed No-AI Browser to Potato Browser: new name, icon and potato:// internal pages. Existing profiles move to the new folder on first launch.

## 0.1.2

- Reworked welcome page: search engine choice, flag modes shown as small feeds, numbered setup steps and a guided Safari import.

## 0.1.1

- Security fixes: screen sharing always asks first, votes count once per network, certificate exceptions are per certificate and session.

## 0.1.0

- First release: AI Shield for major sites, no AI in the engine, and anonymous community flags for AI-generated posts.
