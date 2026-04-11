# Teams Transcript Scraper — Chrome/Edge Extension
## Project Brief for Claude Code

---

## What This Project Does

A Chrome/Edge browser extension that scrapes Microsoft Teams meeting transcripts
directly from the recording player UI and downloads them as a `.vtt` file — with
one button click. No permissions needed, no server, no IT involvement.

---

## The Problem

- Meeting recordings are saved to the organizer's SharePoint
- Attendees can VIEW the transcript in the Teams UI but cannot download it
- The `.vtt` file download button shows: "You don't have permission to download
  the transcript. Contact [organizer] to request access."
- The transcript text is fully rendered in the DOM — we just need to extract it

---

## The User Flow

1. User clicks a meeting recording link in Teams chat
   (e.g. "QGenda and Infor Integration Spec Review-20260312_104558-Meeting Recording.mp4")
2. Teams opens the recording player with the transcript panel on the right
3. User clicks the extension button in the browser toolbar
4. Extension scrapes all transcript entries from the DOM
5. Extension auto-scrolls the transcript panel to capture everything
6. Extension formats the data as a proper `.vtt` file
7. File downloads automatically to the user's Downloads folder
   (e.g. "QGenda_and_Infor_Integration_Spec_Review_20260312.vtt")

---

## Known DOM Elements (Confirmed via Live Inspection)

All three elements confirmed from live Teams recording UI.
Target by PARTIAL class name (before the `-` + hash number) — the hash suffix
changes between Teams updates but the prefix is stable.

### Speaker Name ✅ Confirmed
```html
<span class="itemDisplayName-588">Stacy Haag</span>
```
- Target selector: `[class*="itemDisplayName"]`

### Timestamp ✅ Confirmed
```html
<div role="presentation" class="baseTimestamp-584">
  <span class="screenReaderFriendlyHiddenTag-496">0 minutes 8 seconds</span>
  <span id="Header-timestamp-1" aria-hidden="true">0:08</span>
</div>
```
- Target selector: `[class*="baseTimestamp"]`
- To get the visible time value: find the `span[aria-hidden="true"]` inside it
- Ignore the `screenReaderFriendlyHiddenTag` span — it's for accessibility only
- Format: `M:SS` (e.g. `0:08`) or `H:MM:SS` for longer meetings

### Spoken Text ✅ Confirmed
```html
<div id="sub-entry-1"
     class="entryText-573 textHoverColor-580 clickableItem-489 flexFill-547"
     aria-setsize="533"
     aria-posinset="2"
     role="listitem">
  Well, good morning, folks. I think we've got most folks on now...
</div>
```
- Target selector: `[class*="entryText"]`
- The `aria-posinset` attribute gives the position in the transcript list — useful
  for ordering entries correctly and deduplication
- The `aria-setsize` attribute gives the total number of entries — use this to
  show progress during scroll (e.g. "Captured 45 of 533 entries")

### Parent Container ✅ Confirmed (via live DOM inspection)
Ancestor chain from `entryText` up:
```
1. entryText           ← spoken text
2. baseEntry           ← entry group: contains timestamp + text
3. (unnamed div)
4. rightColumn
5. listItemWithSpeaker ← full row: contains speaker name + all baseEntry items
6. (unnamed div)
7. ms-List-cell
...
```
- To get **timestamp**: go up to `[class*="baseEntry"]`, find `[class*="baseTimestamp"] span[aria-hidden="true"]`
- To get **speaker**: go up to `[class*="listItemWithSpeaker"]`, find `[class*="itemDisplayName"]`

### Scroll Container ✅ Confirmed (via live DOM inspection)
```
DIV.ms-FocusZone.focusZoneWithSearchBox-528.focusZoneWithAutoScroll-407
```
- Target selector: `[class*="focusZoneWithAutoScroll"]`
- Confirmed via `getComputedStyle` — this element has `overflow-y: auto/scroll`

> ✅ All selectors confirmed. No guesswork needed.

---

## Output Format — WebVTT (.vtt)

Standard WebVTT format with speaker names included:

```
WEBVTT

00:00:05.000 --> 00:00:09.000
<v Stacy Haag>Well, good morning, folks. I think we've got most folks on now.

00:00:10.000 --> 00:00:15.000
<v Raquel Escobedo>Thanks Stacy, I wanted to cover the integration spec first.
```

- Timestamps: convert from `M:SS` or `H:MM:SS` → `HH:MM:SS.000`
- Each entry: one cue per transcript block
- Speaker tag: `<v Speaker Name>` per WebVTT spec
- End timestamp: infer from next entry's start time (or add 5s for last entry)

---

## Extension File Structure

```
teams-transcript-extension/
├── manifest.json          # Extension manifest (MV3)
├── popup.html             # Extension popup UI (toolbar button click)
├── popup.js               # Popup logic
├── content.js             # Content script — runs on Teams pages, does the scraping
├── background.js          # Service worker (MV3)
├── styles/
│   └── popup.css          # Popup styling
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## manifest.json Requirements

> **Important:** Teams meeting recordings open in **SharePoint/Stream**, not teams.microsoft.com.
> Example URL: `https://yumaregionalorg-my.sharepoint.com/personal/.../_layouts/15/stream.aspx?...`
> Pattern: `https://{tenant}-my.sharepoint.com/*`
> The content script must match `*.sharepoint.com`, not `teams.microsoft.com`.

```json
{
  "manifest_version": 3,
  "name": "Teams Transcript Exporter",
  "version": "1.0.0",
  "description": "Export Teams meeting transcripts as .vtt files with one click",
  "permissions": ["activeTab", "scripting", "downloads"],
  "host_permissions": [
    "https://*.sharepoint.com/*",
    "https://teams.microsoft.com/*",
    "https://*.teams.microsoft.com/*"
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": { ... }
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.sharepoint.com/*",
        "https://teams.microsoft.com/*",
        "https://*.teams.microsoft.com/*"
      ],
      "js": ["content.js"]
    }
  ],
  "background": {
    "service_worker": "background.js"
  }
}
```

---

## Core Scraper Logic (content.js)

### Step 1 — Detect the transcript panel
Check if any `[class*="entryText"]` elements exist on the page.
If none found, show popup message: "Open the transcript panel first."

### Step 2 — Find total entry count
Read `aria-setsize` from any `[class*="entryText"]` element.
Use this number to show scraping progress: "Captured X of Y entries"

### Step 3 — Auto-scroll to load all entries
Teams uses virtual DOM rendering — only visible entries are in the DOM.
The scraper must:
- Find the scrollable transcript container (ancestor of entryText with overflow scroll)
- Scroll to top first, wait for DOM to settle
- Collect visible entries using `aria-posinset` as the unique key
- Scroll down in increments (300px every 400ms)
- Repeat until `collectedEntries.size === totalEntries` (from aria-setsize)
- Stop when scrollTop + clientHeight >= scrollHeight as fallback

### Step 4 — Extract each entry
For each unique entry (keyed by aria-posinset):
```
speaker  = element.closest(parent).querySelector('[class*="itemDisplayName"]').innerText
timestamp = element.closest(parent).querySelector('[class*="baseTimestamp"] span[aria-hidden="true"]').innerText
text     = element.innerText  (the entryText element itself)
position = parseInt(element.getAttribute('aria-posinset'))
```
Sort final array by `position` before building the .vtt

### Step 5 — Parse timestamps
Input formats from Teams: `0:08`, `1:23`, `1:02:45`
Convert all to VTT format: `00:00:08.000`, `00:01:23.000`, `01:02:45.000`

```js
function toVttTime(teamsTime) {
  const parts = teamsTime.split(':').map(Number);
  let h = 0, m = 0, s = 0;
  if (parts.length === 2) [m, s] = parts;
  if (parts.length === 3) [h, m, s] = parts;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.000`;
}
```

### Step 6 — Build .vtt string
```
WEBVTT\n\n
```
Then for each entry (sorted by aria-posinset):
```
[position]\n
[startTime] --> [endTime]\n
<v [speakerName]>[text]\n
\n
```
End timestamp = next entry's start time, or start + 5s for the last entry.

### Step 7 — Trigger download
Use Blob URL to download the file.
Filename: derive from page `<title>` tag, sanitized (spaces → underscores, strip special chars).
Fallback filename: `teams_transcript_[YYYYMMDD_HHMMSS].vtt`

---

## Popup UI (popup.html)

Keep it simple and clean. Should show:

- Extension name / small logo
- Status message (idle / detecting page / scraping / done)
- One primary button: **"Export Transcript"**
- Progress indicator during scroll+scrape
- Success state: "✓ Downloaded: filename.vtt"
- Error states:
  - "No transcript panel found — open the transcript sidebar first"
  - "Not on a Teams recording page"
  - "No transcript entries found"

---

## Edge Cases to Handle

| Scenario | Handling |
|---|---|
| Transcript panel not open | Show error in popup: "Open the transcript panel first" |
| Very long meeting (200+ entries) | Auto-scroll handles this; show progress % |
| Speaker name missing on some entries | Use previous speaker name (Teams sometimes groups consecutive lines) |
| Duplicate entries during scroll | Deduplicate by timestamp key |
| Teams is in desktop app, not browser | Extension won't work — popup shows: "Open recording in browser" |
| Page is not a Teams recording | Show: "Navigate to a Teams meeting recording first" |
| URL is on SharePoint/Stream (expected) | Content script matches `*.sharepoint.com` — this IS the correct URL pattern for recordings |

---

## Development & Testing

### Load the extension locally:
1. Open Edge/Chrome → `edge://extensions` or `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `teams-transcript-extension/` folder

### Test with:
- A real Teams recording link from a meeting chat
- Open the recording → open the transcript panel → click extension button
- Verify `.vtt` downloads with correct speaker names, timestamps, text

### Debugging:
- Right-click extension popup → Inspect → Console for popup.js errors
- On the Teams page → F12 → Console for content.js errors
- Check `chrome://extensions` for service worker errors

---

## Phase 2 — Future Features (Do NOT build yet)

These are planned for later. Document here for awareness:

### AI Chat Interface
- After `.vtt` is exported, offer a chat panel inside the popup
- Load the transcript as context
- User can ask: "What were the action items?" / "What did Stacy say about X?"
- Use Groq API (free) or Claude API for responses
- All transcript data stays local — only the query + relevant excerpt sent to API

### Auto Email Summary
- After scraping, optionally send a formatted summary via Gmail SMTP
- Summary includes: attendees, key topics, decisions, action items
- Triggered from the same popup with a second button: "Export + Email Summary"

### Auto-detect and open transcript
- Automatically open the transcript panel if not already open
- Detect when user is on a recording page and pre-load the scraper

---

## Questions to Resolve During Build

1. ✅ ~~Timestamp element class name~~ → `[class*="baseTimestamp"]`, value from `span[aria-hidden="true"]`
2. ✅ ~~Text element class name~~ → `[class*="entryText"]`
3. ✅ ~~Total entry count~~ → read from `aria-setsize` on any `entryText` element
4. ✅ ~~Entry ordering~~ → read from `aria-posinset` on each `entryText` element

**All confirmed via live DOM inspection:**
- **Entry group parent** — `[class*="baseEntry"]` (timestamp + text)
- **Row parent (speaker)** — `[class*="listItemWithSpeaker"]` (speaker name + entries)
- **Scroll container** — `[class*="focusZoneWithAutoScroll"]`

---

## Summary

**Stack:** Vanilla JS + Chrome Extension MV3 (no frameworks needed)
**Permissions:** activeTab, scripting, downloads
**External APIs:** None (Phase 1 is fully offline)
**Target browsers:** Microsoft Edge (primary), Chrome (secondary)
**Hosting:** None — runs entirely in the browser
**Cost:** $0
