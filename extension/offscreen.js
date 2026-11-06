// Offscreen document: captures the tab's audio, runs the on-device AI (brain.js),
// and plays the audio back with automatic, learned volume control.
//
// Signal path:  tab audio ─┬─> leveler (AI-controlled gain) ─> compressor ─> limiter ─> speakers
//                          ├─> analyser (loudness + bass/voice balance, 20x per second)
//                          └─> pcm-tap worklet ─> 16 kHz ─> Silero VAD + YAMNet

const { SceneBrain, Ears, Resampler } = globalThis.AVT;

let ctx = null, stream = null, timer = null;
let analyser, leveler, src, timeBuf, freqBuf, lastTs = 0;
let brain = null;
let ears = null, earsLoading = null;
let aiState = 'off';            // off | loading | ready | basic
let player = { db: 0, known: false, muted: false };
let pendingDelta = 0, deltaTimer = null, lastLearn = null;

const dbToLin = (db) => Math.pow(10, db / 20);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg.streamId, msg.settings, msg.prefs).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) })
      );
      return true;
    case 'stop':
      stop(); sendResponse({ ok: true }); break;
    case 'settings':
      if (brain) brain.settings = { ...brain.settings, ...msg.settings };
      sendResponse({ ok: true }); break;
    case 'reset':
      if (brain) brain.relearn();
      sendResponse({ ok: true }); break;
    case 'forget':
      if (brain) brain.forget();
      lastLearn = null;
      sendResponse({ ok: true }); break;
    case 'volume':
      onPlayerVolume(msg.volume); sendResponse({ ok: true }); break;
    case 'feedback':
      sendResponse(teach(msg.delta, 'key')); break;
    case 'status':
      sendResponse(brain ? { running: !!ctx, aiState, lastLearn, ...brain.status() } : { running: false });
      break;
  }
});

async function start(streamId, settings, prefs) {
  stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  ctx = new AudioContext({ latencyHint: 'interactive' });
  src = ctx.createMediaStreamSource(stream);

  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.5;
  leveler = ctx.createGain();

  const comp = ctx.createDynamicsCompressor();   // catches single gunshots faster than the AI can react
  comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3;
  comp.attack.value = 0.005; comp.release.value = 0.3;

  const limiter = ctx.createDynamicsCompressor(); // final safety net
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.001; limiter.release.value = 0.1;

  src.connect(analyser);
  src.connect(leveler).connect(comp).connect(limiter).connect(ctx.destination);

  timeBuf = new Float32Array(analyser.fftSize);
  freqBuf = new Float32Array(analyser.frequencyBinCount);
  brain = new SceneBrain(settings, prefs);
  player = { db: 0, known: false, muted: false };
  lastLearn = null;
  lastTs = performance.now();
  timer = setInterval(tick, 50);

  startAI(ctx).catch((e) => {
    console.warn('AI unavailable, using basic mode:', e);
    if (ctx) aiState = 'basic';
  });
}

async function loadEars() {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  ort.env.wasm.numThreads = 1;
  const [vad, yam] = await Promise.all(
    ['models/silero_vad.onnx', 'models/yamnet.onnx'].map((p) => fetch(p).then((r) => r.arrayBuffer()))
  );
  const e = new Ears(ort);
  await e.init(vad, yam);
  return e;
}

async function startAI(myCtx) {
  aiState = 'loading';
  if (!ears) ears = await (earsLoading ||= loadEars()); // models load once, then stay warm
  if (ctx !== myCtx) return;                             // stopped/restarted meanwhile
  ears.reset();
  ears.onSpeech = (p, dt) => brain && brain.onSpeech(p, dt);
  ears.onScores = (s) => brain && brain.onScores(s);

  await myCtx.audioWorklet.addModule('pcm-tap.js');
  if (ctx !== myCtx) return;
  const tap = new AudioWorkletNode(myCtx, 'pcm-tap');
  const silent = myCtx.createGain();
  silent.gain.value = 0;                                 // keeps the tap running without being heard
  src.connect(tap).connect(silent).connect(myCtx.destination);
  const resampler = new Resampler(myCtx.sampleRate, 16000);
  tap.port.onmessage = (e) => { if (ctx === myCtx) ears.push(resampler.process(e.data)); };
  aiState = 'ready';
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) ctx.close().catch(() => {});
  ctx = null;
  aiState = 'off';
}

function bandDb(loHz, hiHz) {
  const binHz = ctx.sampleRate / analyser.fftSize;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(freqBuf.length - 1, Math.ceil(hiHz / binHz));
  let e = 0;
  for (let i = lo; i <= hi; i++) e += Math.pow(10, freqBuf[i] / 10);
  return 10 * Math.log10(e + 1e-12);
}

function tick() {
  const t = performance.now();
  const dt = Math.min((t - lastTs) / 1000, 0.2);
  lastTs = t;

  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
  let levelDb = 10 * Math.log10(sum / timeBuf.length + 1e-12);
  // Undo the site's own volume so the brain sees the movie's real loudness
  if (player.known && !player.muted) levelDb -= player.db;

  analyser.getFloatFrequencyData(freqBuf);
  const bassVsVoice = bandDb(20, 150) - bandDb(300, 3400);

  const g = brain.onLevel(levelDb, bassVsVoice, dt);
  leveler.gain.setTargetAtTime(dbToLin(g), ctx.currentTime, 0.03);
}

// ---------- learning from the user ----------

function onPlayerVolume(volume) {
  if (!brain) return;
  if (!(volume > 0.0005)) { player.muted = true; return; }
  const db = 20 * Math.log10(volume);
  if (player.known && !player.muted) {
    const delta = db - player.db;
    if (Math.abs(delta) >= 0.3 && brain.t > 3) {
      // a slider drag sends many events: add them up and learn once you let go
      pendingDelta += delta;
      clearTimeout(deltaTimer);
      deltaTimer = setTimeout(() => {
        const d = pendingDelta; pendingDelta = 0;
        if (Math.abs(d) >= 1) teach(d, 'player');
      }, 1200);
    }
  }
  player = { db, known: true, muted: false };
}

function teach(delta, source) {
  if (!brain) return { ok: false };
  const res = brain.learn(delta, source);
  if (!res) return { ok: true, learned: null, scene: brain.scene };
  lastLearn = { ...res, delta: Math.round(delta * 10) / 10, at: Date.now() };
  chrome.runtime.sendMessage({ target: 'background', type: 'savePrefs', prefs: brain.prefs }).catch(() => {});
  return { ok: true, learned: res };
}
