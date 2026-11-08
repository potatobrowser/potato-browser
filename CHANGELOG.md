# Changelog

Each `## <version>` section becomes the notes of that GitHub Release.

## 0.8.0

- Not AI votes: when a post made by a person gets flagged as AI, press Not AI. Not AI votes cancel AI flags one for one, so a buried post comes back for everyone once enough people disagree.
- Report a problem: the AI Shield and ad blocker panels have a button for when AI or ads still show, or a page breaks. It sends the page address and your choice, nothing else.
- AI Shield fixes arrive the same day: the rules now update daily from potatobrowser.com, signed by us, so a change on Google or YouTube no longer waits for a new version.
- Crash reports, if you want them: switch them on in the welcome page or in Settings, Privacy, and a crash sends us a report so we can fix it. Off unless you switch it on.
- Cookies are now encrypted with the key in your macOS Keychain, as passwords already were. You stay signed in to your sites.
- The daily check for filter list updates now also says which version you run, so we can count how many people use Potato Browser. It still says nothing about you. potatobrowser.com/privacy lists everything the browser sends.
- Faster start with lots of tabs: only the tab in front loads when the browser opens. The others show their title and load when you click them, back and forward history included.
- Tabs you leave alone take a nap. After 2 hours in the background a tab gives its memory back, and a click wakes it up where you left it, scroll position and typed text included. Tabs playing sound, sharing your camera, microphone or screen, or holding unsaved changes stay awake. Change the time or turn it off in Settings, General, Put unused tabs to sleep.
- Reopened and duplicated tabs keep their back and forward history.
- PDFs: Save Page As saves the PDF itself, and the browser's zoom no longer shows a percentage the PDF viewer ignores. Use the viewer's own zoom buttons.
- Quitting while a page is still loading no longer gets stuck behind an error message.

## 0.7.1

- Google sign-in works again. Google turned it down with "This browser or app may not be secure" because, on its sign-in pages, the browser claimed to be Firefox. It now tells Google what it really is, and every other site still sees a plain Chrome browser.

## 0.7.0

- Updates install themselves. Every few hours the browser asks potatobrowser.com for a new version, downloads it in the background, and a Restart to update button appears in the toolbar. One click and you are on the new version, with your windows and tabs back. Quitting installs it too.
- Every update is checked twice before it installs: the download must match the checksum published with the release, and macOS installs it only when it is signed by the same developer as the browser you run. The check sends nothing about you.
- Updates work for the copy in your Applications folder. A copy started from the disk image points you to the download page instead.
- Coming from 0.6.0 or older: download this version once from potatobrowser.com, or run brew upgrade. Later versions arrive on their own.

## 0.6.0

- Built-in password manager. After you sign in, the browser offers to save the password, or to update it when it changed. On the next visit, saved logins show up in a list under the sign-in field, and nothing is filled until you pick one.
- Passwords are encrypted with a key kept in your macOS Keychain and never leave your Mac. Pages cannot read the list or pick from it for you, and a password only goes to the site it was saved for.
- Import passwords from the CSV exports of Chrome, Edge, Brave, Arc, Safari, Firefox and 1Password, in the new Passwords page (Potato Browser menu, Passwords). Passwords already saved are never overwritten, and the page offers to move the export file to the Trash.
- The Passwords page shows, copies, edits, deletes and exports saved passwords, asking for Touch ID or your Mac password first. Settings, Passwords turns saving and filling off, and "Never for this site" is remembered.
- Private windows fill saved passwords but never save new ones.

## 0.5.0

- Built-in ad blocker, on by default: ads, video ads, pop-ups and trackers never load. It uses the EasyList, EasyPrivacy and uBlock Origin filter lists, with uBlock's scriptlets that keep video ads off YouTube.
- A new ad blocker button in the toolbar shows how many ads and trackers were blocked on the page and which servers they came from, and lets ads through on one site.
- Settings, Ad blocker: block trackers, hide cookie notices, hide annoyances such as newsletter pop-ups, sites where ads are allowed, your own filters, and the filter lists in use.
- Filter lists update once a day through potatobrowser.com. The request names the lists and nothing about you; it can be turned off.
- The new tab page counts the ads and trackers blocked today.

## 0.4.2

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
