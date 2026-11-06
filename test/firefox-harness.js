// Runs inside the Firefox add-on (as an extension page). Firefox can't play sound on a headless
// test machine, so instead of playing the soundtrack it:
//  1. streams test/out/movie.wav to the add-on's real background page (the AI models) over the
//     same port the content script uses, and runs the real brain.js on the results;
//  2. checks the content script's safety rules on real web pages.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { errors: [] };
window.addEventListener('error', (e) => R.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => R.errors.push(String(e.reason)));

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, h = len / 2;
    for (let i = 0; i < n; i += len) for (let k = 0; k < h; k++) {
      const wr = Math.cos(a * k), wi = Math.sin(a * k);
      const xr = re[i + k + h] * wr - im[i + k + h] * wi, xi = re[i + k + h] * wi + im[i + k + h] * wr;
      re[i + k + h] = re[i + k] - xr; im[i + k + h] = im[i + k] - xi; re[i + k] += xr; im[i + k] += xi;
    }
  }
}
function bassVsVoice(x, end, sr) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const j = end - N + i; re[i] = j >= 0 ? x[j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)) : 0; }
  fft(re, im);
  const band = (lo, hi) => { let e = 0; for (let k = Math.max(1, Math.floor(lo * N / sr)); k <= Math.ceil(hi * N / sr); k++) e += re[k] ** 2 + im[k] ** 2; return 10 * Math.log10(e + 1e-12); };
  return band(20, 150) - band(300, 3400);
}

async function aiPipeline() {
  const t0 = performance.now();
  const buf = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(await (await fetch('movie.wav')).arrayBuffer());
  const x = buf.getChannelData(0), sr = buf.sampleRate;
  const brain = new AVT.SceneBrain();
  const rs = new AVT.Resampler(sr);
  const port = browser.runtime.connect({ name: 'avt-ai' });
  let onReady, onAI;
  const ready = new Promise((r) => (onReady = r));
  port.onMessage.addListener((m) => {
    if (m.t === 'ready') onReady(true);
    else if (m.t === 'error') { R.aiError = m.e; onReady(false); }
    else if (m.t === 'ai') {
      for (const [p, dt] of m.sp) brain.onSpeech(p, dt);
      if (m.sc) brain.onScores(m.sc);
      if (onAI) { const f = onAI; onAI = null; f(); }
    }
  });
  R.aiReady = await Promise.race([ready, sleep(20000).then(() => false)]);
  R.aiReadyMs = Math.round(performance.now() - t0);
  if (!R.aiReady) return;

  const step = Math.round(sr * 0.05), log = [];
  for (let i = 0; i + step <= x.length; i += step) {
    const chunk = x.subarray(i, i + step);
    const got = new Promise((r) => (onAI = r));
    port.postMessage({ t: 'audio', d: rs.process(chunk) }); // same message the content script sends
    await Promise.race([got, sleep(2000)]);
    let e = 0; for (const v of chunk) e += v * v;
    const g = brain.onLevel(10 * Math.log10(e / chunk.length + 1e-12), bassVsVoice(x, i + step, sr), 0.05);
    const t = i / sr;
    if (!R.learned && t >= 14) R.learned = brain.learn(-6, 'player');
    if (R.learned && !R.undo && t >= 24) R.undo = brain.learn(6, 'player') || 'ignored';
    log.push([+t.toFixed(2), brain.scene, +g.toFixed(2)]);
  }
  port.disconnect();
  R.log = log;
  R.prefs = brain.prefs;
  R.pipelineMs = Math.round(performance.now() - t0);
}

async function contentScriptSafety() {
  const open = async (url) => {
    const tab = await browser.tabs.create({ url, active: true });
    await sleep(3500);
    return tab;
  };
  const ask = (tab, type) => browser.tabs.sendMessage(tab.id, { type }).catch((e) => ({ sendError: String(e) }));

  const withMedia = await open('http://127.0.0.1:8765/media.html');
  R.mediaPing = await ask(withMedia, 'avt-ping');
  R.mediaEnable = await ask(withMedia, 'avt-enable');
  R.mediaStatus = await ask(withMedia, 'avt-status');
  const [state] = await browser.tabs.executeScript(withMedia.id, { code: '({ paused: document.querySelector("audio").paused, t: document.querySelector("audio").currentTime })' });
  R.mediaStillPlaying = state;

  const noMedia = await open('http://127.0.0.1:8765/empty.html');
  R.noMediaEnable = await ask(noMedia, 'avt-enable');
}

(async () => {
  try { await aiPipeline(); } catch (e) { R.errors.push('pipeline: ' + e); }
  try { await contentScriptSafety(); } catch (e) { R.errors.push('content: ' + e); }
  window.__done = R;
  document.title = 'done';
  await fetch('http://127.0.0.1:8765/report/harness', { method: 'POST', body: JSON.stringify(R) }).catch(() => {});
})();
