# Teams Transcript Exporter

A browser extension that exports Microsoft Teams meeting transcripts as `.vtt` files with one click — no permissions needed, no server, no IT involvement.

## The Problem

When you open a Teams meeting recording on SharePoint, the transcript is visible but the download button is locked:

> *"You don't have permission to download the transcript. Contact [organizer] to request access."*

The transcript text is fully loaded in your browser. This extension reads it directly and saves it to your device.

## How It Works

1. Open a Teams meeting recording link — it opens on SharePoint/Stream
2. Open the **Transcript panel** on the right side of the player
3. Click the extension icon in your browser toolbar
4. Click **Export Transcript** — a `.vtt` file downloads instantly

The extension reads transcript data directly from React's in-memory state, bypassing the virtualized list entirely. No scrolling, no waiting — all entries are captured at once regardless of meeting length.

## Features

- Instant export — no DOM scrolling or waiting
- Full transcript regardless of meeting length
- Speaker names and accurate timestamps included
- Standard WebVTT (`.vtt`) format — compatible with video players, transcription tools, and AI apps
- Works entirely in your browser — nothing is sent to any server
- Free and open source (MIT License)

## Install

| Browser | Store |
|---|---|
| Microsoft Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/mddafbeijigbdbchhdiimghjggmckfip) *(pending review)* |
| Chrome | Chrome Web Store *(pending review)* |
| Firefox | Firefox Add-ons *(pending review)* |

## Load Unpacked (Developer Mode)

**Edge / Chrome:**
1. Go to `edge://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `teams-transcript-extension/` folder

**Firefox:**
1. Go to `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on**
3. Select `teams-transcript-extension/manifest.json`

## Project Structure

```
teams-transcript-extension/   # Extension source
├── manifest.json             # MV3 manifest
├── background.js             # Service worker — fiber extraction + download
├── content.js                # Content script — transcript panel detection
├── popup.html                # Toolbar popup UI
├── popup.js                  # Popup logic
├── styles/popup.css          # Popup styling
└── icons/                    # Extension icons

store-assets/                 # Store listing assets (not part of extension)
├── screenshot1-3.png         # Store screenshots (640x400)
├── promotional_small.png     # Small promo tile (440x280)
└── promotional_large.png     # Large promo tile (1400x560)
```

## Technical Approach

Teams recording pages run on SharePoint and render transcripts using a virtualized React list. Only visible entries are in the DOM at any time.

Rather than scrolling the DOM to collect entries one by one, the extension uses `chrome.scripting.executeScript` with `world: 'MAIN'` to run code directly in the page's JavaScript context. From there it walks the React fiber tree to find the full `items` array in memory — all transcript cues, speakers, and ISO 8601 timestamps — and returns them instantly.

This approach bypasses both the virtualized list and SharePoint's Content Security Policy, which blocks inline script injection.

## Branches

| Branch | Target |
|---|---|
| `master` | Edge + Chrome |
| `firefox` | Firefox AMO (manifest adjustments for Gecko) |

## License

[MIT](LICENSE) — © 2026 JazzPiece
