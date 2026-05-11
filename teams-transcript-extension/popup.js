// Teams Transcript Exporter — popup script

const statusIcon = document.getElementById('status-icon');
const statusText = document.getElementById('status-text');
const progressArea = document.getElementById('progress-area');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const exportBtn = document.getElementById('export-btn');
const copyBtn   = document.getElementById('copy-btn');

let selectedFormat = 'vtt';

document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.format;
  });
});

function setFormatLocked(locked) {
  document.querySelectorAll('.format-btn').forEach(btn => { btn.disabled = locked; });
}

function setStatus(state, message) {
  statusIcon.className = `status-icon ${state}`;
  statusText.textContent = message;
}

function showProgress(captured, total) {
  progressArea.classList.remove('hidden');
  const pct = total > 0 ? Math.round((captured / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `${captured} of ${total} entries`;
}

function hideProgress() {
  progressArea.classList.add('hidden');
}

// Listen for progress/done/error messages from background.js
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'progress') {
    setStatus('scraping', 'Exporting transcript...');
    showProgress(message.captured, message.total);
  } else if (message.type === 'done') {
    setStatus('done', `Downloaded: ${message.filename} · ${message.count} entries`);
    showProgress(message.count, message.count);
    progressFill.style.width = '100%';
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export Again';
    copyBtn.disabled = false;
    setFormatLocked(false);
  } else if (message.type === 'error') {
    setStatus('error', message.message);
    hideProgress();
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
    copyBtn.disabled = false;
    setFormatLocked(false);
  } else if (message.type === 'copyReady') {
    navigator.clipboard.writeText(message.text).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.disabled = false;
      setStatus('done', `Copied ${message.count} entries to clipboard.`);
      setTimeout(() => { copyBtn.textContent = 'Copy Text'; }, 2000);
    }).catch(() => {
      copyBtn.textContent = 'Copy Text';
      copyBtn.disabled = false;
      setStatus('error', 'Clipboard write failed — try again.');
    });
  }
});

copyBtn.addEventListener('click', async () => {
  copyBtn.disabled = true;
  copyBtn.textContent = 'Copying...';
  setStatus('scraping', 'Reading transcript...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ action: 'copy', tabId: tab.id });
});

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting...';
  setFormatLocked(true);
  setStatus('scraping', 'Starting export...');
  hideProgress();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Send to background — it runs fiber extraction in the page's main world
  chrome.runtime.sendMessage({ action: 'scrape', tabId: tab.id, format: selectedFormat });
});

// On popup open — ping the content script to check page state
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });

    if (response.status === 'ready') {
      setStatus('ready', 'Transcript panel detected. Ready to export.');
      exportBtn.disabled = false;
      copyBtn.disabled = false;
    } else if (response.status === 'no-transcript') {
      setStatus('warning', 'Open the transcript panel first, then click Export.');
      exportBtn.disabled = true;
      copyBtn.disabled = true;
    } else {
      setStatus('error', 'Navigate to a Teams meeting recording first.');
      exportBtn.disabled = true;
      copyBtn.disabled = true;
    }
  } catch {
    // Content script not injected — not on a matching page
    setStatus('error', 'Not on a Teams recording page.');
    exportBtn.disabled = true;
    copyBtn.disabled = true;
  }
}

init();
