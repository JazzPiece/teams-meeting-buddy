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
  if (document.querySelector('[class*="entryText"]')) {
    sendResponse({ status: 'ready' });
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
