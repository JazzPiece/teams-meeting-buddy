// Teams Transcript Exporter — service worker
//
// Handles scraping by running fiber extraction in the page's main world
// via chrome.scripting.executeScript({ world: 'MAIN' }).
// This bypasses both the isolated-world restriction AND SharePoint's CSP.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrape') {
    handleScrape(message.tabId, message.format || 'vtt', !!message.merge);
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === 'copy') {
    handleCopy(message.tabId, !!message.merge);
    sendResponse({ ok: true });
    return true;
  }
});

// ── Scrape ────────────────────────────────────────────────────────────────────

async function handleScrape(tabId, format, merge) {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Extraction timed out. Try reopening the transcript panel.')), 10000)
    );

    // Run fiber extraction in the page's main JS world — has full React access
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: extractTranscriptFromFiber }),
      timeout
    ]);

    let items = results[0]?.result;

    if (!items || items.length === 0) {
      sendToPopup({ type: 'error', message: 'Could not read transcript from React state. Make sure the transcript panel is open and fully loaded.' });
      return;
    }

    if (merge) items = mergeCues(items);

    sendToPopup({ type: 'progress', captured: items.length, total: items.length });

    const tab = await chrome.tabs.get(tabId);
    const extMap = { vtt: 'vtt', srt: 'srt', docx: 'docx', compact: 'txt' };
    const filename = buildFilename(tab.title || '', extMap[format] || format);

    // Download using a data URL — works from service worker without blob/URL APIs
    let dataUrl;
    if (format === 'docx') {
      const bytes  = buildDocx(items);
      let binary   = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      dataUrl = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + btoa(binary);
    } else if (format === 'srt') {
      dataUrl = 'data:text/srt;charset=utf-8,' + encodeURIComponent(buildSrt(items));
    } else if (format === 'compact') {
      dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(buildCompact(items));
    } else {
      dataUrl = 'data:text/vtt;charset=utf-8,' + encodeURIComponent(buildVtt(items));
    }
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

    sendToPopup({ type: 'done', filename, count: items.length });

  } catch (err) {
    sendToPopup({ type: 'error', message: err.message || 'Unknown error during export.' });
  }
}

// ── Copy ──────────────────────────────────────────────────────────────────────

async function handleCopy(tabId, merge) {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Extraction timed out. Try reopening the transcript panel.')), 10000)
    );
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: extractTranscriptFromFiber }),
      timeout
    ]);
    let items = results[0]?.result;
    if (!items || items.length === 0) {
      sendToPopup({ type: 'error', message: 'Could not read transcript. Make sure the transcript panel is open.' });
      return;
    }
    if (merge) items = mergeCues(items);
    sendToPopup({ type: 'copyReady', text: buildPlainText(items), count: items.length });
  } catch (err) {
    sendToPopup({ type: 'error', message: err.message || 'Unknown error during copy.' });
  }
}

function buildPlainText(cues) {
  return cues.map(item => {
    const sec = parseDuration(item.timestamp);
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const s   = Math.floor(sec % 60);
    const ts  = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    const speaker = item.speakerDisplayName ? `${item.speakerDisplayName} [${ts}]` : `[${ts}]`;
    return `${speaker}\n${item.text}`;
  }).join('\n\n');
}

// ── Fiber extraction — THIS FUNCTION RUNS IN THE PAGE'S MAIN WORLD ───────────
// Must be fully self-contained (no external references — Chrome serializes it).

function extractTranscriptFromFiber() {
  function fiberWalk(domNode) {
    const key = Object.keys(domNode)
      .find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return null;

    let node = domNode[key];
    // Cap at 50 ancestors — prevents runaway traversal if the fiber tree has an unexpected shape
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

// ── Merge consecutive same-speaker cues ──────────────────────────────────────

function mergeCues(cues) {
  if (!cues || cues.length === 0) return cues;
  const merged = [];
  let current = { ...cues[0] };
  for (let i = 1; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.speakerDisplayName === current.speakerDisplayName) {
      current.text += ' ' + cue.text;
      if (cue.endTime) current.endTime = cue.endTime;
    } else {
      merged.push(current);
      current = { ...cue };
    }
  }
  merged.push(current);
  return merged;
}

// ── VTT builder ───────────────────────────────────────────────────────────────

function buildVtt(cues) {
  let vtt = 'WEBVTT\n\n';
  cues.forEach((item, i) => {
    const start  = parseDuration(item.timestamp);
    const end    = parseDuration(item.endTime);
    // Some entries have missing/equal end times — pad by 1s so the cue has a valid duration
    const endAdj = end > start ? end : start + 1;
    vtt += `${i + 1}\n`;
    vtt += `${toVTTTime(start)} --> ${toVTTTime(endAdj)}\n`;
    vtt += `<v ${item.speakerDisplayName}>${item.text}\n\n`;
  });
  return vtt;
}

function parseDuration(pt) {
  if (!pt) return 0;
  // Teams stores timestamps as ISO 8601 durations (e.g. "PT1H23M4.5S")
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

// ── SRT builder ───────────────────────────────────────────────────────────────

function buildSrt(cues) {
  let srt = '';
  cues.forEach((item, i) => {
    const start  = parseDuration(item.timestamp);
    const end    = parseDuration(item.endTime);
    const endAdj = end > start ? end : start + 1;
    const line   = item.speakerDisplayName ? `${item.speakerDisplayName}: ${item.text}` : item.text;
    srt += `${i + 1}\n${toSRTTime(start)} --> ${toSRTTime(endAdj)}\n${line}\n\n`;
  });
  return srt;
}

function toSRTTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
       + ',' + String(ms).padStart(3, '0');
}

// ── Compact builder (token-efficient plain text for LLM input) ────────────────
//
// Output structure:
//   A=Alice Johnson  B=Bob Smith
//
//   [0:00]A: Welcome everyone.
//   [1:23]B: Thanks. Here are the results.
//
// Savings vs VTT: ~60-70% fewer tokens on a typical transcript.
// Always merges consecutive same-speaker turns regardless of the merge toggle.

function buildCompact(cues) {
  const merged = mergeCues(cues);

  // Assign single-letter codes in order of first appearance
  const codes = new Map();
  const alpha  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const cue of merged) {
    const name = cue.speakerDisplayName || '';
    if (!codes.has(name)) {
      const i = codes.size;
      codes.set(name, i < 26 ? alpha[i] : alpha[Math.floor(i / 26) - 1] + alpha[i % 26]);
    }
  }

  // Legend — only named speakers
  const legendParts = [];
  for (const [name, code] of codes) {
    if (name) legendParts.push(`${code}=${name}`);
  }
  const legend = legendParts.length ? legendParts.join('  ') + '\n\n' : '';

  // One line per turn: [M:SS]A: text  (H:MM:SS only for meetings > 1 hour)
  const lines = merged.map(cue => {
    const sec = parseDuration(cue.timestamp);
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const s   = Math.floor(sec % 60);
    const ts  = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
    const code = codes.get(cue.speakerDisplayName || '') || '';
    return `[${ts}]${code ? code + ': ' : ''}${stripFillers(cue.text)}`;
  });

  return legend + lines.join('\n');
}

function stripFillers(text) {
  // Vocal fillers — nearly always noise in meeting transcripts
  text = text.replace(/\b(um+h?|uh+|er+|ah+|h+m+|mhm)\b,?\s*/gi, ' ');
  // High-confidence discourse markers that add no information
  text = text.replace(/\b(you know|i mean),?\s*/gi, ' ');
  // Sentence-opening throwaways: "So, ...", "Well, ...", "Right, ...", "Okay, ..."
  text = text.replace(/^(so|well|right|alright|okay|ok),\s+/i, '');
  text = text.replace(/([.?!]\s+)(so|well|right|alright|okay|ok),\s+/gi, '$1');
  // Collapse any double-spaces left behind, strip leading comma/space
  return text.replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();
}

// ── Filename ──────────────────────────────────────────────────────────────────

function buildFilename(title, ext = 'vtt') {
  title = title.replace(/\s*[-–]\s*(Microsoft\s+)?Stream\s*$/i, '');
  title = title.replace(/-\d{8}_\d{6}-Meeting Recording/i, '');
  title = title.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!title) {
    const now = new Date();
    title = `teams_transcript_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }
  return `${title}.${ext}`;
}

// ── DOCX builder ──────────────────────────────────────────────────────────────

function buildDocx(cues) {
  const enc = new TextEncoder();

  function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toReadableTime(pt) {
    const sec = parseDuration(pt);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
  }

  let paragraphs = '';
  for (const item of cues) {
    const speaker = xmlEscape(item.speakerDisplayName || 'Unknown');
    const time    = toReadableTime(item.timestamp);
    const text    = xmlEscape(item.text);
    paragraphs += `<w:p><w:pPr><w:spacing w:before="160" w:after="0"/></w:pPr>` +
      `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${speaker}  </w:t></w:r>` +
      `<w:r><w:rPr><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr><w:t>${time}</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return buildZip([
    { name: '[Content_Types].xml',          data: enc.encode(contentTypesXml) },
    { name: '_rels/.rels',                  data: enc.encode(relsXml) },
    { name: 'word/document.xml',            data: enc.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(wordRelsXml) },
  ]);
}

// Builds an uncompressed (STORE) ZIP archive from an array of {name, data} entries.
function buildZip(files) {
  const entries = [];
  const localParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const { data } = file;
    const crc  = crc32(data);
    const size = data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0,  0x04034b50, true); // local file header signature
    lv.setUint16(4,  20,         true); // version needed
    lv.setUint16(6,  0,          true); // flags
    lv.setUint16(8,  0,          true); // compression: STORE
    lv.setUint16(10, 0,          true); // mod time
    lv.setUint16(12, 0,          true); // mod date
    lv.setUint32(14, crc,        true);
    lv.setUint32(18, size,       true); // compressed size
    lv.setUint32(22, size,       true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0,          true); // extra field length
    lh.set(nameBytes, 30);

    entries.push({ nameBytes, crc, size, offset });
    localParts.push(lh, data);
    offset += lh.length + size;
  }

  const cdParts = [];
  let cdSize = 0;
  const cdOffset = offset;

  for (const e of entries) {
    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0,  0x02014b50, true); // central directory signature
    cv.setUint16(4,  20,         true);
    cv.setUint16(6,  20,         true);
    cv.setUint16(8,  0,          true);
    cv.setUint16(10, 0,          true);
    cv.setUint16(12, 0,          true);
    cv.setUint16(14, 0,          true);
    cv.setUint32(16, e.crc,      true);
    cv.setUint32(20, e.size,     true);
    cv.setUint32(24, e.size,     true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0,          true); // extra
    cv.setUint16(32, 0,          true); // comment
    cv.setUint16(34, 0,          true); // disk start
    cv.setUint16(36, 0,          true); // internal attrs
    cv.setUint32(38, 0,          true); // external attrs
    cv.setUint32(42, e.offset,   true); // local header offset
    cd.set(e.nameBytes, 46);
    cdParts.push(cd);
    cdSize += cd.length;
  }

  const eocdr = new Uint8Array(22);
  const ev = new DataView(eocdr.buffer);
  ev.setUint32(0,  0x06054b50,     true); // end of central directory signature
  ev.setUint16(4,  0,              true);
  ev.setUint16(6,  0,              true);
  ev.setUint16(8,  entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize,         true);
  ev.setUint32(16, cdOffset,       true);
  ev.setUint16(20, 0,              true);

  const allParts = [...localParts, ...cdParts, eocdr];
  const total = allParts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of allParts) { out.set(p, pos); pos += p.length; }
  return out;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — ignore
  });
}
