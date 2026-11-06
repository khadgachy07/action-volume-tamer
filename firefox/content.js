// Firefox content script. Firefox has no tab-capture API, so the add-on attaches to the
// page's own <video>/<audio> elements with Web Audio instead.
//
//   video ─> input ─┬─> dry ──────────────────────────────────────────> speakers   (when off)
//                   ├─> leveler (AI-controlled) ─> compressor ─> limiter ─> wet ─> speakers
//                   ├─> analyser (loudness + bass/voice balance, 20x per second)
//                   └─> tap ─> 16 kHz ─> background page: Silero VAD + YAMNet
//
// Safety: once a video is attached to Web Audio it can't be detached until the page reloads.
//  - It only attaches once the audio engine is actually running (otherwise the video would go silent).
//  - If a site blocks audio processing (copy protection / cross-origin media), the attached video
//    goes silent. It detects that, says so in the popup, remembers the site, and offers a reload.
(() => {
  if (window.__avtFirefox) return;
  window.__avtFirefox = true;

  const { SceneBrain, Resampler } = globalThis.AVT;
  const dbToLin = (db) => Math.pow(10, db / 20);
  const host = location.hostname;

  let enabled = false, ctx = null, nodes = null, brain = null, port = null, timer = null;
  let aiState = 'off', problem = null, waitingForClick = false;
  const hooked = new Set();
  let observer = null;
  let lastTs = 0, timeBuf, freqBuf;
  let player = { db: 0, known: false, muted: false }, pendingDelta = 0, deltaTimer = null, lastLearn = null;
  let volumeApplied = true; // does the browser apply the video's own volume before Web Audio? (checked at runtime)
  let recentRaw = [];        // raw levels for that check
  let notAppliedVotes = 0;
  let silence = { since: null, hookedAt: 0 };

  const media = () => [...document.querySelectorAll('video, audio')];
  const mainMedia = () => {
    const all = media();
    const playing = all.filter((m) => !m.paused);
    return (playing.length ? playing : all).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  };

  // ---------- audio graph ----------
  function buildGraph() {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    const input = ctx.createGain();
    const playerGain = ctx.createGain(); // only used if the browser doesn't apply the video's volume itself
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const leveler = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.3;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.5;
    const tap = ctx.createScriptProcessor(4096, 1, 1); // no worklet: page security rules can block worklet files
    const mute = ctx.createGain(); mute.gain.value = 0;

    input.connect(analyser);
    input.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
    input.connect(playerGain);
    playerGain.connect(dry); dry.connect(ctx.destination);
    playerGain.connect(leveler); leveler.connect(comp); comp.connect(limiter); limiter.connect(wet); wet.connect(ctx.destination);
    dry.gain.value = 1; wet.gain.value = 0;

    const resampler = new Resampler(ctx.sampleRate, 16000);
    tap.onaudioprocess = (e) => {
      if (!enabled || !port || aiState !== 'ready') return;
      const out = resampler.process(e.inputBuffer.getChannelData(0));
      try { port.postMessage({ t: 'audio', d: out }); } catch { /* port closed */ }
    };
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
    nodes = { input, playerGain, dry, wet, leveler, analyser, tap };
  }

  function setWet(on) {
    const t = ctx.currentTime;
    nodes.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.05);
    nodes.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.05);
  }

  function hook(m) {
    if (hooked.has(m)) return;
    try {
      const src = ctx.createMediaElementSource(m);
      src.connect(nodes.input);
      hooked.add(m);
      silence = { since: null, hookedAt: performance.now() };
      m.addEventListener('volumechange', () => onPlayerVolume(m));
      onPlayerVolume(m);
    } catch (e) {
      // e.g. the site already attached its own Web Audio graph to this element
      console.info('AVT: could not attach to media element', e);
    }
  }

  function hookAll() { media().forEach(hook); }

  // ---------- turning on / off ----------
  async function enable() {
    const stored = await browser.storage.local.get(['settings', 'prefs', 'blockedSites', 'volumeApplied']);
    if ((stored.blockedSites || []).includes(host)) return { ok: false, reason: 'blocked' };
    if (!media().length) return { ok: false, reason: 'no-media' };
    if (stored.volumeApplied === false) volumeApplied = false;

    if (!ctx) buildGraph();
    if (ctx.state !== 'running') {
      try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]); } catch { /* ignore */ }
    }
    if (ctx.state !== 'running') {
      // Attaching now would silence the video. Wait for a click/key on the page, then finish.
      if (!waitingForClick) {
        waitingForClick = true;
        const finish = async () => {
          ['pointerdown', 'keydown'].forEach((ev) => document.removeEventListener(ev, finish, true));
          waitingForClick = false;
          await ctx.resume().catch(() => {});
          if (ctx.state === 'running') enable();
        };
        ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, finish, true));
      }
      return { ok: false, reason: 'needs-click' };
    }

    if (!brain) brain = new SceneBrain(stored.settings, stored.prefs);
    else { brain.settings = { ...brain.settings, ...(stored.settings || {}) }; }
    hookAll();
    if (!observer) {
      observer = new MutationObserver(() => { if (enabled) hookAll(); }); // Netflix swaps the video between episodes
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    connectAI();
    enabled = true;
    problem = null;
    setWet(true);
    lastTs = performance.now();
    if (!timer) timer = setInterval(tick, 50);
    browser.runtime.sendMessage({ type: 'avt-badge', on: true }).catch(() => {});
    return { ok: true };
  }

  function disable() {
    enabled = false;
    if (ctx) setWet(false);          // the video stays attached, but plays untouched
    if (timer) clearInterval(timer);
    timer = null;
    if (port) { try { port.disconnect(); } catch { /* ignore */ } }
    port = null; aiState = 'off';
    browser.runtime.sendMessage({ type: 'avt-badge', on: false }).catch(() => {});
    return { ok: true };
  }

  function connectAI() {
    if (port) return;
    aiState = 'loading';
    port = browser.runtime.connect({ name: 'avt-ai' });
    port.onMessage.addListener((msg) => {
      if (msg.t === 'ready') aiState = 'ready';
      else if (msg.t === 'error') aiState = 'basic';
      else if (msg.t === 'ai' && brain) {
        for (const [p, dt] of msg.sp) brain.onSpeech(p, dt);
        if (msg.sc) brain.onScores(msg.sc);
      }
    });
    port.onDisconnect.addListener(() => { port = null; if (enabled) aiState = 'basic'; });
  }

  // ---------- 20x per second ----------
  function bandDb(lo, hi) {
    const binHz = ctx.sampleRate / nodes.analyser.fftSize;
    const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(freqBuf.length - 1, Math.ceil(hi / binHz));
    let e = 0;
    for (let i = a; i <= b; i++) e += Math.pow(10, freqBuf[i] / 10);
    return 10 * Math.log10(e + 1e-12);
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min((now - lastTs) / 1000, 0.2);
    lastTs = now;
    const an = nodes.analyser;
    an.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const raw = 10 * Math.log10(sum / timeBuf.length + 1e-12);
    recentRaw.push([now, raw]);
    if (recentRaw.length > 60) recentRaw.shift();
    checkSilence(raw, now);

    let level = raw;
    if (volumeApplied && player.known && !player.muted) level -= player.db; // see the movie's real loudness
    an.getFloatFrequencyData(freqBuf);
    const g = brain.onLevel(level, bandDb(20, 150) - bandDb(300, 3400), dt);
    nodes.leveler.gain.setTargetAtTime(dbToLin(g), ctx.currentTime, 0.03);
  }

  // If an attached video plays but nothing comes out, the site is blocking audio processing.
  function checkSilence(raw, now) {
    const m = mainMedia();
    const audible = m && hooked.has(m) && !m.paused && !m.muted && m.volume > 0 && m.readyState >= 3;
    if (!audible || raw > -110 || problem) { silence.since = null; return; }
    silence.since ??= now;
    const early = now - silence.hookedAt < 60000; // real movies are rarely digitally silent this long
    if (early && now - silence.since > 5000) {
      problem = 'blocked';
      disable();
      browser.storage.local.get('blockedSites').then(({ blockedSites = [] }) => {
        if (!blockedSites.includes(host)) browser.storage.local.set({ blockedSites: [...blockedSites, host] });
      });
    }
  }

  // ---------- the player's own volume ----------
  function onPlayerVolume(m) {
    if (m !== mainMedia() || !brain) return;
    const vol = m.muted ? 0 : m.volume;
    nodes.playerGain.gain.value = volumeApplied ? 1 : vol;
    if (!(vol > 0.0005)) { player.muted = true; return; }
    const db = 20 * Math.log10(vol);
    if (player.known && !player.muted) {
      const delta = db - player.db;
      if (Math.abs(delta) >= 4 && enabled) verifyVolumeApplied(delta);
      if (Math.abs(delta) >= 0.3 && brain.t > 3) {
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

  // Check once whether the measured level follows the player's volume. If it doesn't, the browser
  // isn't applying it before Web Audio, so the add-on applies it itself (keeps your volume slider working).
  function verifyVolumeApplied(delta) {
    const t0 = performance.now();
    const before = recentRaw.filter(([t]) => t > t0 - 600).map(([, v]) => v);
    setTimeout(() => {
      const after = recentRaw.filter(([t]) => t > t0 + 150).map(([, v]) => v);
      if (before.length < 4 || after.length < 4) return;
      const avg = (a) => a.reduce((p, v) => p + v, 0) / a.length;
      const measured = avg(after) - avg(before);
      // The movie itself changes loudness too, so it takes two consistent readings to switch
      if (Math.abs(measured) >= Math.abs(delta) / 2) { notAppliedVotes = 0; return; }
      if (volumeApplied && Math.abs(measured) < Math.abs(delta) / 4 && ++notAppliedVotes >= 2) {
        volumeApplied = false;
        browser.storage.local.set({ volumeApplied: false });
        const m = mainMedia();
        if (m) nodes.playerGain.gain.value = m.muted ? 0 : m.volume;
      }
    }, 750);
  }

  function teach(delta, source) {
    if (!brain) return { ok: false };
    const res = brain.learn(delta, source);
    if (!res) return { ok: true, learned: null };
    lastLearn = { ...res, at: Date.now() };
    browser.storage.local.set({ prefs: brain.prefs });
    return { ok: true, learned: res };
  }

  // ---------- popup / shortcuts ----------
  browser.runtime.onMessage.addListener((msg) => {
    if (typeof msg?.type !== 'string' || !msg.type.startsWith('avt-')) return;
    // Only frames that have media (or are already on) answer, so the popup talks to the right one
    if (!enabled && !hooked.size && !media().length && msg.type !== 'avt-ping') return;
    switch (msg.type) {
      case 'avt-ping': return Promise.resolve({ ok: true, hasMedia: media().length > 0 });
      case 'avt-enable': return enable();
      case 'avt-disable': return Promise.resolve(disable());
      case 'avt-settings':
        if (brain) brain.settings = { ...brain.settings, ...msg.settings };
        return Promise.resolve({ ok: true });
      case 'avt-reset': brain?.relearn(); return Promise.resolve({ ok: true });
      case 'avt-forget': brain?.forget(); lastLearn = null; return Promise.resolve({ ok: true });
      case 'avt-feedback': return Promise.resolve(enabled ? teach(msg.delta, 'key') : { ok: false });
      case 'avt-status':
        return Promise.resolve({
          running: enabled, aiState, problem, waitingForClick, lastLearn,
          hooked: hooked.size, volumeApplied, ...(brain ? brain.status() : {})
        });
    }
  });
})();
