const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noopListener = { addListener() {} };
const context = {
  chrome: {
    commands: { onCommand: noopListener },
    runtime: { onInstalled: noopListener, onMessage: noopListener, sendMessage: () => Promise.resolve() },
    storage: { local: { get: () => Promise.resolve({}) } },
    tabs: {},
    scripting: {},
    downloads: {}
  },
  console,
  setTimeout,
  URL,
  Blob,
  Date,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  btoa: value => Buffer.from(value, 'binary').toString('base64')
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), context);

const selectedTitle = {
  textContent: 'Selected Meeting',
  matches: () => false,
  closest: () => ({})
};
const otherTitle = {
  textContent: 'Unrelated Sidebar Meeting',
  matches: () => false,
  closest: () => null
};
context.document = {
  querySelector(selector) {
    if (selector === '[data-tid="intelligent-recap-header"] span[dir="auto"]') {
      return { textContent: 'Tuesday, September 15, 2026 11:00 AM - 12:00 PM' };
    }
    if (selector === '#OneTranscript') return {};
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '[class*="entryText"]') return [{}];
    if (selector === '[id^="title-chat-list-item_"][role="text"]') return [otherTitle, selectedTitle];
    return [];
  }
};
const metadataReport = context.detectTranscriptPage();
assert.equal(metadataReport.meetingSubject, 'Selected Meeting');
assert.equal(metadataReport.meetingDateText, 'Tuesday, September 15, 2026 11:00 AM - 12:00 PM');

const recap = context.buildFilename(
  {
    meetingDateText: 'Tuesday, September 15, 2026 11:00 AM - 12:00 PM',
    meetingSubject: '  Quarterly: Sales / Planning?  '
  },
  'Microsoft Teams',
  'srt',
  new Date(2000, 0, 1)
);
assert.equal(recap, '20260915 - Quarterly Sales Planning.srt');

const recordingTitle = context.buildFilename(
  {},
  'Weekly Sync-20260914_090000-Meeting Recording - Microsoft Stream',
  'vtt',
  new Date(2000, 0, 1)
);
assert.equal(recordingTitle, '20260914 - Weekly Sync.vtt');

const fallback = context.buildFilename({}, 'Microsoft Teams', 'docx', new Date(2026, 8, 13));
assert.equal(fallback, '20260913 - Teams Transcript.docx');

const capped = context.buildFilename(
  { meetingDateText: '2026-09-15', meetingSubject: `${'A'.repeat(250)}...` },
  '',
  'txt'
);
assert.ok(capped.length <= 180);
assert.doesNotMatch(capped, /[<>:"/\\|?*]/);
assert.doesNotMatch(capped.replace(/\.txt$/, ''), /[ .]$/);

(async () => {
  const downloads = [];
  const revoked = [];
  context.chrome.downloads.download = async options => {
    downloads.push(options);
    return downloads.length;
  };
  context.URL = {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      return 'blob:mock-download';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    }
  };
  context.setTimeout = callback => callback();

  await context.downloadPayload('Firefox payload', 'text/vtt;charset=utf-8', 'firefox.vtt');
  assert.equal(downloads[0].url, 'blob:mock-download');
  assert.deepEqual(revoked, ['blob:mock-download']);

  context.URL = {};
  await context.downloadPayload('Chromium payload', 'text/vtt;charset=utf-8', 'chromium.vtt');
  assert.match(downloads[1].url, /^data:text\/vtt;charset=utf-8;base64,/);
  assert.equal(
    Buffer.from(downloads[1].url.split(',')[1], 'base64').toString('utf8'),
    'Chromium payload'
  );
  await context.downloadPayload(
    new Uint8Array([0, 127, 255]),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'chromium.docx'
  );
  assert.deepEqual([...Buffer.from(downloads[2].url.split(',')[1], 'base64')], [0, 127, 255]);

  console.log('filename and download branches: passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
