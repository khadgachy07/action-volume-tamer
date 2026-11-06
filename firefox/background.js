// Firefox background page: runs the two AI models (Silero VAD + YAMNet) for every tab
// that has the extension turned on. Each tab's content script streams 16 kHz audio here
// over a port and gets back speech probabilities and sound-type scores.

const { Ears } = globalThis.AVT;
let models = null; // Promise<{vad, yam}> — loaded once, shared by all tabs

function loadModels() {
  if (!models) {
    models = (async () => {
      ort.env.wasm.wasmPaths = browser.runtime.getURL('lib/');
      ort.env.wasm.numThreads = 1;
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [vadBuf, yamBuf] = await Promise.all(
        ['models/silero_vad.onnx', 'models/yamnet.onnx'].map((p) => fetch(p).then((r) => r.arrayBuffer()))
      );
      return {
        vad: await ort.InferenceSession.create(vadBuf, opts),
        yam: await ort.InferenceSession.create(yamBuf, opts)
      };
    })();
    models.catch(() => (models = null)); // allow a retry later
  }
  return models;
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'avt-ai') return;
  let ears = null, alive = true;
  let speech = [], scores = null;

  const flush = () => {
    if (!alive || (!speech.length && !scores)) return;
    try { port.postMessage({ t: 'ai', sp: speech, sc: scores }); } catch { alive = false; }
    speech = []; scores = null;
  };

  loadModels().then(({ vad, yam }) => {
    if (!alive) return;
    ears = new Ears(ort).useSessions(vad, yam);
    ears.onSpeech = (p, dt) => speech.push([p, dt]);
    ears.onScores = (s) => (scores = Float32Array.from(s));
    port.postMessage({ t: 'ready' });
  }).catch((e) => {
    console.warn('AVT: AI models failed to load', e);
    if (alive) port.postMessage({ t: 'error', e: String(e) });
  });

  port.onMessage.addListener((msg) => {
    if (!ears) return;
    if (msg.t === 'audio') ears.push(msg.d).then(flush);
    else if (msg.t === 'reset') ears.reset();
  });
  port.onDisconnect.addListener(() => { alive = false; ears = null; });
});

// Badge shows which tabs are on
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'avt-badge' && sender.tab) {
    browser.browserAction.setBadgeText({ text: msg.on ? 'ON' : '', tabId: sender.tab.id });
    browser.browserAction.setBadgeBackgroundColor({ color: '#2e7d32', tabId: sender.tab.id });
  }
});

// Keyboard shortcuts → the active tab
browser.commands.onCommand.addListener(async (command) => {
  const delta = command === 'too-loud' ? -3 : command === 'too-quiet' ? 3 : 0;
  if (!delta) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) browser.tabs.sendMessage(tab.id, { type: 'avt-feedback', delta }).catch(() => {});
});

loadModels(); // warm up so the first tab starts quickly
