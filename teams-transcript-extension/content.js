// Teams Transcript Exporter — content script
// Uses React Fiber to read transcript data directly from memory,
// bypassing list virtualization. No DOM scrolling needed.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    handlePing(sendResponse);
    return true;
  }
  if (message.action === 'scrape') {
    handleScrape();
    sendResponse({ ok: true });
    return true;
  }
});

// ── Ping: check if transcript data is accessible ─────────────────────────────

function handlePing(sendResponse) {
  const listEl = document.querySelector('.ms-List');
  if (!listEl) {
    // No Fluent UI list — check if we're at least on a recording page
    const isRecordingPage =
      location.href.includes('stream.aspx') ||
      location.href.includes('/personal/') ||
      document.querySelector('[class*="focusZoneWithAutoScroll"]') !== null;
    sendResponse({ status: isRecordingPage ? 'no-transcript' : 'wrong-page' });
    return;
  }

  try {
    const items = getTranscriptItemsFromFiber(listEl);
    if (items && items.length > 0) {
      sendResponse({ status: 'ready' });
    } else {
      sendResponse({ status: 'no-transcript' });
    }
  } catch {
    // Fiber walk failed — list exists but can't read data yet
    sendResponse({ status: 'no-transcript' });
  }
}

// ── Scrape: pull all cues from React state and download ───────────────────────

function handleScrape() {
  try {
    const listEl = document.querySelector('.ms-List');
    if (!listEl) {
      sendProgress({ type: 'error', message: 'Transcript list not found. Open the transcript panel first.' });
      return;
    }

    const allItems = getTranscriptItemsFromFiber(listEl);
    if (!allItems || allItems.length === 0) {
      sendProgress({ type: 'error', message: 'Could not read transcript data. Try closing and reopening the transcript panel.' });
      return;
    }

    // Keep only spoken-text cues; skip header/divider/speaker-label rows
    const cues = allItems.filter(item =>
      item.type === 'Text' && item.text && item.text.trim()
    );

    if (cues.length === 0) {
      sendProgress({ type: 'error', message: 'No transcript text entries found in the data.' });
      return;
    }

    sendProgress({ type: 'progress', captured: cues.length, total: cues.length });

    const vttString = buildVtt(cues);
    const filename  = buildFilename();

    triggerDownload(vttString, filename);
    sendProgress({ type: 'done', filename, count: cues.length });

  } catch (err) {
    sendProgress({ type: 'error', message: err.message || 'Unknown error during export.' });
  }
}

// ── React Fiber: walk up from a DOM node to find the items array ──────────────

function getTranscriptItemsFromFiber(domNode) {
  const fiberKey = Object.keys(domNode)
    .find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));

  if (!fiberKey) {
    throw new Error('React fiber not found. Is the page fully loaded?');
  }

  let node = domNode[fiberKey];
  for (let i = 0; i < 15; i++) {
    const props = node.memoizedProps;
    if (props && Array.isArray(props.items) && props.items.length > 20) {
      const sample = props.items[0];
      if (sample && (sample.text !== undefined || sample.speakerDisplayName)) {
        return props.items;
      }
    }
    if (!node.return) break;
    node = node.return;
  }
  return null;
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────

// Parse ISO 8601 duration (e.g. "PT4M55S", "PT1H2M45.5S") → total seconds
function parseDuration(pt) {
  if (!pt) return 0;
  const m = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600)
       + (parseInt(m[2] || 0) * 60)
       + parseFloat(m[3] || 0);
}

// Total seconds → WebVTT timestamp "HH:MM:SS.mmm"
function toVTTTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
       + '.' + String(ms).padStart(3, '0');
}

// ── VTT builder ───────────────────────────────────────────────────────────────

function buildVtt(cues) {
  let vtt = 'WEBVTT\n\n';
  cues.forEach((item, i) => {
    const start  = parseDuration(item.timestamp);
    const end    = parseDuration(item.endTime);
    const endAdj = end > start ? end : start + 1; // ensure end > start
    vtt += `${i + 1}\n`;
    vtt += `${toVTTTime(start)} --> ${toVTTTime(endAdj)}\n`;
    vtt += `<v ${item.speakerDisplayName}>${item.text.trim()}\n\n`;
  });
  return vtt;
}

// ── Filename: derived from page title ────────────────────────────────────────

function buildFilename() {
  let title = document.title || '';
  // Strip " - Stream" / " - Microsoft Stream" suffix
  title = title.replace(/\s*[-–]\s*(Microsoft\s+)?Stream\s*$/i, '');
  // Strip recording date+time suffix like "-20260312_104558-Meeting Recording"
  title = title.replace(/-\d{8}_\d{6}-Meeting Recording/i, '');
  // Sanitize to safe filename characters
  title = title.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!title) {
    const now = new Date();
    title = `teams_transcript_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }
  return `${title}.vtt`;
}

// ── Download trigger ──────────────────────────────────────────────────────────

function triggerDownload(vttString, filename) {
  const blob = new Blob([vttString], { type: 'text/vtt' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: filename,
    style: 'display:none'
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendProgress(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may have closed — ignore
  });
}
