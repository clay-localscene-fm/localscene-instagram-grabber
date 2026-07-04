# LocalScene Instagram Grabber

LocalScene Instagram Grabber is a browser extension for LocalScene contributors.
It helps move selected Instagram profile details and public photo-post images
into an open LocalScene form using your own browser session.

This repository is provided for temporary manual installation while the Chrome
Web Store and Firefox Add-ons listings are under review. Once the store listings
are approved, LocalScene will point users to the normal browser store installs
instead.

## Install in Chrome

1. Open this repository on GitHub.
2. Click the green **Code** button.
3. Click **Download ZIP**.
4. Unzip the downloaded file.
5. Open Chrome and go to `chrome://extensions`.
6. Turn on **Developer mode** in the top-right corner.
7. Click **Load unpacked**.
8. Select the unzipped `localscene-instagram-grabber-main` folder.
9. Pin the LocalScene Instagram Grabber extension from Chrome's extensions menu.

## Install Temporarily in Firefox

Firefox support is packaged here for contributor testing while the Firefox
Add-ons listing is under review. Temporary Firefox add-ons are removed when
Firefox restarts, so you may need to repeat these steps.

1. Open `localscene-instagram-grabber-firefox.zip` in this repository.
2. Click the download button for the raw file.
3. Unzip the downloaded file.
4. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
5. Click **Load Temporary Add-on**.
6. Select `manifest.json` inside the unzipped Firefox package folder.
7. Pin or open LocalScene Instagram Grabber from Firefox's extensions menu.

## Use the Grabber

1. Open `https://localscene.fm`.
2. Open a LocalScene form that has an Instagram grabber target.
3. Click **Open grabber** from that form.
4. Paste a public Instagram profile URL or public Instagram photo post URL.
5. Send the selected profile or post data back to the open LocalScene form.

## Notes

- The extension does not ask for your Instagram password.
- It reads the selected Instagram page you choose and sends the selected data
  back to the LocalScene tab that opened the grabber.
- Private profiles, login checkpoints, blocked pages, and non-photo posts may
  not import successfully.
- For support, visit
  `https://localscene.fm/about/instagram-grabber-support`.

All rights reserved.
