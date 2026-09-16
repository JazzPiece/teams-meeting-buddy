// Teams Transcript Exporter — service worker
//
// Handles scraping by running fiber extraction in the page's main world
// via chrome.scripting.executeScript({ world: 'MAIN' }).
// This bypasses both the isolated-world restriction AND SharePoint's CSP.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Teams Transcript Exporter installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'detect') {
    findTranscriptFrame(message.tabId)
      .then(sendResponse)
      .catch(err => sendResponse({ status: 'error', message: safeErrorMessage(err, 'Could not inspect this page.') }));
    return true;
  }
  if (message.action === 'scrape') {
    handleScrape(message.tabId);
    sendResponse({ ok: true });
    return true;
  }
});

async function findTranscriptFrame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: detectTranscriptPage
  });

  const reports = results
    .filter(result => result.result)
    .map(result => ({ frameId: result.frameId, ...result.result }));
  const ready = reports
    .filter(report => report.status === 'ready')
    .sort((a, b) =>
      Number(b.hasTranscriptContainer) - Number(a.hasTranscriptContainer) ||
      b.count - a.count ||
      a.frameId - b.frameId
    )[0];
  const metadataReports = [...reports].sort((a, b) =>
    Number(b.frameId === 0) - Number(a.frameId === 0) || a.frameId - b.frameId
  );
  const metadata = {
    meetingDateText: metadataReports.find(report => report.meetingDateText)?.meetingDateText || '',
    meetingSubject: metadataReports.find(report => report.meetingSubject)?.meetingSubject || ''
  };

  if (ready) return { ...ready, ...metadata };
  if (reports.some(report => report.status === 'no-transcript')) {
    return { status: 'no-transcript' };
  }
  return { status: 'wrong-page' };
}

function detectTranscriptPage() {
  function readMeetingMetadata() {
    const dateElement = document.querySelector('[data-tid="intelligent-recap-header"] span[dir="auto"]');
    const titleSelector = '[id^="title-chat-list-item_"][role="text"]';
    const selectedScope = [
      '[aria-selected="true"]',
      '[aria-current="true"]',
      '[data-is-selected="true"]',
      '[data-selected="true"]'
    ].join(', ');
    const titleCandidates = [...document.querySelectorAll(titleSelector)];
    const selectedTitle = titleCandidates.find(element =>
      element.matches(selectedScope) || element.closest(selectedScope)
    );
    const titleElement = selectedTitle || (titleCandidates.length === 1 ? titleCandidates[0] : null);
    return {
      meetingDateText: dateElement?.textContent?.trim() || '',
      meetingSubject: titleElement?.textContent?.trim() || ''
    };
  }

  const metadata = readMeetingMetadata();
  const entries = document.querySelectorAll('[class*="entryText"]');
  if (entries.length > 0) {
    return {
      status: 'ready',
      count: entries.length,
      hasTranscriptContainer: document.querySelector('#OneTranscript') !== null,
      ...metadata
    };
  }

  const isRecordingPage =
    location.href.includes('stream.aspx') ||
    location.href.includes('/personal/') ||
    document.querySelector('#xplatIframe') !== null ||
    document.querySelector('[data-tid="Transcript"]') !== null ||
    document.querySelector('.ms-List') !== null ||
    document.querySelector('[class*="focusZoneWithAutoScroll"]') !== null;
  return { status: isRecordingPage ? 'no-transcript' : 'wrong-page', ...metadata };
}

// ── Scrape ────────────────────────────────────────────────────────────────────

async function handleScrape(tabId) {
  try {
    const frame = await findTranscriptFrame(tabId);
    if (frame.status !== 'ready') {
      throw new Error(frame.status === 'no-transcript'
        ? 'Open the transcript panel first, then try again.'
        : 'Navigate to a Teams meeting recording first.');
    }
    const target = { tabId, frameIds: [frame.frameId] };

    // Run fiber extraction in the page's main JS world — has full React access
    const results = await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: extractTranscriptFromFiber
    });

    const items = results[0]?.result;

    if (!items || items.length === 0) {
      sendToPopup({ type: 'error', message: 'Could not read transcript from React state. Make sure the transcript panel is open and fully loaded.' });
      return;
    }

    sendToPopup({ type: 'progress', captured: items.length, total: items.length });

    const vtt      = buildVtt(items);
    const tab      = await chrome.tabs.get(tabId);
    const filename = buildFilename(frame, tab.title || '', 'vtt');

    await downloadPayload(vtt, 'text/vtt;charset=utf-8', filename);

    sendToPopup({ type: 'done', filename, count: items.length });

  } catch (err) {
    sendToPopup({
      type: 'error',
      message: safeErrorMessage(err, 'Export failed. Firefox could not start the download. Try again.')
    });
  }
}

async function downloadPayload(payload, mimeType, filename) {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob === 'function') {
    const objectUrl = URL.createObjectURL(new Blob([payload], { type: mimeType }));
    try {
      return await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }
  }

  const bytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

function safeErrorMessage(err, fallback) {
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!message || message.length > 300 || /(?:data|blob):/i.test(message)) return fallback;
  return message.replace(/https?:\/\/\S+/gi, 'the current page').slice(0, 300);
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

function buildFilename(metadata, fallbackTitle, ext = 'vtt', fallbackDate = new Date()) {
  const date = formatMeetingDate(metadata?.meetingDateText, fallbackTitle, fallbackDate);
  const extension = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'vtt';
  let subject = metadata?.meetingSubject || cleanDocumentTitle(fallbackTitle) || 'Teams Transcript';
  subject = sanitizeFilenamePart(subject);

  const maxLength = 180;
  const fixedLength = date.length + extension.length + 4;
  subject = subject.slice(0, Math.max(1, maxLength - fixedLength)).replace(/[ .]+$/g, '');
  return `${date} - ${subject}.${extension}`;
}

function formatMeetingDate(dateText, fallbackTitle, fallbackDate) {
  const source = `${dateText || ''} ${fallbackTitle || ''}`;
  const compact = source.match(/\b(20\d{2})(\d{2})(\d{2})[_-]\d{6}\b/);
  if (compact) return `${compact[1]}${compact[2]}${compact[3]}`;

  const iso = source.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}${String(iso[2]).padStart(2, '0')}${String(iso[3]).padStart(2, '0')}`;

  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const written = source.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b/i);
  if (written) {
    return `${written[3]}${String(months[written[1].toLowerCase()]).padStart(2, '0')}${String(written[2]).padStart(2, '0')}`;
  }

  const date = fallbackDate instanceof Date && !Number.isNaN(fallbackDate.getTime())
    ? fallbackDate
    : new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function cleanDocumentTitle(title) {
  const cleaned = String(title || '')
    .replace(/\s*[-–|]\s*(Microsoft\s+)?Stream\s*$/i, '')
    .replace(/\s*[-–|]\s*Microsoft Teams\s*$/i, '')
    .replace(/-\d{8}_\d{6}-Meeting Recording/i, '')
    .replace(/\bMeeting Recording\b/gi, '')
    .trim();
  return /^(Microsoft Teams|Teams|Stream)$/i.test(cleaned) ? '' : cleaned;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ .]+$/g, '') || 'Teams Transcript';
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — ignore
  });
}
