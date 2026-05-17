// Teams Transcript Exporter — content script (isolated world)
// Only handles ping (DOM detection). Scraping is done by background.js
// via chrome.scripting.executeScript({ world: 'MAIN' }).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    handlePing(sendResponse);
    return true;
  }
});

function handlePing(sendResponse) {
  const entries = document.querySelectorAll('[class*="entryText"]');
  if (entries.length > 0) {
    sendResponse({ status: 'ready', count: entries.length });
    return;
  }
  // Multiple signals because SharePoint URL structure and DOM classes vary across tenants/Teams versions
  const isRecordingPage =
    location.href.includes('stream.aspx') ||
    location.href.includes('/personal/') ||
    document.querySelector('.ms-List') !== null ||
    document.querySelector('[class*="focusZoneWithAutoScroll"]') !== null;
  sendResponse({ status: isRecordingPage ? 'no-transcript' : 'wrong-page' });
}
