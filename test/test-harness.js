// Runs inside the real extension in Chrome. Replaces tab capture with the test soundtrack,
// then drives the unmodified offscreen.js and records what the AI decides.
(async () => {
  const srcCtx = new AudioContext();
  const buf = await srcCtx.decodeAudioData(await (await fetch('movie.wav')).arrayBuffer());
  const dest = srcCtx.createMediaStreamDestination();
  const playerVol = srcCtx.createGain(); // stands in for the site's video volume
  playerVol.connect(dest);
  navigator.mediaDevices.getUserMedia = async () => dest.stream;

  await start('fake-stream', null, null);
  const node = srcCtx.createBufferSource();
  node.buffer = buf;
  node.connect(playerVol);
  node.start();
  const t0 = performance.now();
  const log = [];
  const iv = setInterval(() => {
    log.push({ t: +((performance.now() - t0) / 1000).toFixed(1), aiState, ...brain.status() });
  }, 250);

  onPlayerVolume(1.0);
  // At 14 s, during the first fight, the "user" turns the player down to 50% (-6 dB)
  setTimeout(() => { playerVol.gain.value = 0.5; onPlayerVolume(0.5); }, 14000);
  // At 24 s, back in dialogue, they turn it back up (should NOT be learned as a preference)
  setTimeout(() => { playerVol.gain.value = 1.0; onPlayerVolume(1.0); }, 24000);

  node.onended = () => {
    clearInterval(iv);
    window.__done = { log, stats: ears && ears.stats, lastLearn, prefs: brain.prefs, sampleRate: ctx.sampleRate };
  };
})().catch((e) => (window.__done = { error: String(e.stack || e) }));
