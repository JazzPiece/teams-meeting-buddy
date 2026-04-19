// Teams Transcript Exporter — service worker
//
// Handles scraping by running fiber extraction in the page's main world
// via chrome.scripting.executeScript({ world: 'MAIN' }).
// This bypasses both the isolated-world restriction AND SharePoint's CSP.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrape') {
    handleScrape(message.tabId);
    sendResponse({ ok: true });
    return true;
  }
});

// ── Scrape ────────────────────────────────────────────────────────────────────

async function handleScrape(tabId) {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Extraction timed out. Try reopening the transcript panel.')), 10000)
    );

    // Run fiber extraction in the page's main JS world — has full React access
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: extractTranscriptFromFiber }),
      timeout
    ]);

    const items = results[0]?.result;

    if (!items || items.length === 0) {
      sendToPopup({ type: 'error', message: 'Could not read transcript from React state. Make sure the transcript panel is open and fully loaded.' });
      return;
    }

    sendToPopup({ type: 'progress', captured: items.length, total: items.length });

    const vtt      = buildVtt(items);
    const tab      = await chrome.tabs.get(tabId);
    const filename = buildFilename(tab.title || '');

    // Download using a data URL — works from service worker without blob/URL APIs
    const dataUrl = 'data:text/vtt;charset=utf-8,' + encodeURIComponent(vtt);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

    sendToPopup({ type: 'done', filename, count: items.length });

  } catch (err) {
    sendToPopup({ type: 'error', message: err.message || 'Unknown error during export.' });
  }
}

// ── Fiber extraction — THIS FUNCTION RUNS IN THE PAGE'S MAIN WORLD ───────────
// Must be fully self-contained (no external references — Chrome serializes it).

function extractTranscriptFromFiber() {
  function fiberWalk(domNode) {
    const key = Object.keys(domNode)
      .find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return null;

    let node = domNode[key];
    for (let i = 0; i < 50; i++) {
      const p = node.memoizedProps;
      if (p && Array.isArray(p.items) && p.items.length > 0) {
        const sample = p.items[0];
        if (sample && (sample.text !== undefined || sample.speakerDisplayName)) {
          return p.items;
        }
      }
      if (!node.return) break;
      node = node.return;
    }
    return null;
  }

  const anchors = [
    document.querySelector('.ms-List'),
    document.querySelector('.ms-List-cell'),
    document.querySelector('[class*="entryText"]'),
    document.querySelector('[class*="listItemWithSpeaker"]'),
    document.querySelector('[class*="focusZoneWithAutoScroll"]'),
  ].filter(Boolean);

  let allItems = null;
  for (const el of anchors) {
    try {
      const result = fiberWalk(el);
      if (result && result.length > 0) { allItems = result; break; }
    } catch {}
  }

  if (!allItems) return null;

  return allItems
    .filter(item => item.type === 'Text' && item.text && item.text.trim())
    .map(item => ({
      speakerDisplayName: item.speakerDisplayName || '',
      timestamp:          item.timestamp  || '',
      endTime:            item.endTime    || '',
      text:               item.text.trim()
    }));
}

// ── VTT builder ───────────────────────────────────────────────────────────────

function buildVtt(cues) {
  let vtt = 'WEBVTT\n\n';
  cues.forEach((item, i) => {
    const start  = parseDuration(item.timestamp);
    const end    = parseDuration(item.endTime);
    const endAdj = end > start ? end : start + 1;
    vtt += `${i + 1}\n`;
    vtt += `${toVTTTime(start)} --> ${toVTTTime(endAdj)}\n`;
    vtt += `<v ${item.speakerDisplayName}>${item.text}\n\n`;
  });
  return vtt;
}

function parseDuration(pt) {
  if (!pt) return 0;
  const m = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600)
       + (parseInt(m[2] || 0) * 60)
       + parseFloat(m[3] || 0);
}

function toVTTTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
       + '.' + String(ms).padStart(3, '0');
}

// ── Filename ──────────────────────────────────────────────────────────────────

function buildFilename(title) {
  title = title.replace(/\s*[-–]\s*(Microsoft\s+)?Stream\s*$/i, '');
  title = title.replace(/-\d{8}_\d{6}-Meeting Recording/i, '');
  title = title.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!title) {
    const now = new Date();
    title = `teams_transcript_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }
  return `${title}.vtt`;
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — ignore
  });
}
