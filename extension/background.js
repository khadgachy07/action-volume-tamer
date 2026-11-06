// Service worker: owns the offscreen audio document, tracks the active tab,
// relays player-volume changes and keyboard shortcuts, and saves what was learned.

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Analyse and adjust tab audio to tame loud action scenes'
  });
}

async function getActive() {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId;
}

async function start(tabId, streamId) {
  await ensureOffscreen();
  const { settings, prefs } = await chrome.storage.local.get(['settings', 'prefs']);
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, settings, prefs });
  if (!res?.ok) throw new Error(res?.error || 'Could not start audio processing');

  const prev = await getActive();
  if (prev && prev !== tabId) chrome.action.setBadgeText({ text: '', tabId: prev }).catch(() => {});
  await chrome.storage.session.set({ activeTabId: tabId });
  chrome.action.setBadgeText({ text: 'ON', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32', tabId });
  requestPlayerVolume(tabId);
}

// Ask the page for its player volume; inject the watcher if the tab was open before install.
async function requestPlayerVolume(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'avt-report-volume' });
  } catch {
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
}

async function stop() {
  const activeTabId = await getActive();
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  if (activeTabId) chrome.action.setBadgeText({ text: '', tabId: activeTabId }).catch(() => {});
  await chrome.storage.session.remove('activeTabId');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  (async () => {
    try {
      switch (msg.type) {
        case 'start': await start(msg.tabId, msg.streamId); break;
        case 'stop': await stop(); break;
        case 'volume': // from content.js
          if (sender.tab && sender.tab.id === (await getActive())) {
            chrome.runtime.sendMessage({ target: 'offscreen', type: 'volume', volume: msg.volume }).catch(() => {});
          }
          break;
        case 'savePrefs': // from offscreen.js
          await chrome.storage.local.set({ prefs: msg.prefs });
          break;
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (!(await getActive())) return;
  const delta = command === 'too-loud' ? -3 : command === 'too-quiet' ? 3 : 0;
  if (delta) chrome.runtime.sendMessage({ target: 'offscreen', type: 'feedback', delta }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getActive())) stop();
});
