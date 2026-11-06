// Offline test: plays test/out/movie.wav through the extension's real brain.js and AI models
// (ONNX Runtime Web, WebAssembly) in Node, three ways: basic mode, AI, and AI after learning.
// Exits with code 1 if any check fails.
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-web');
const AVT = require('../extension/brain.js');
ort.env.wasm.numThreads = 1;

const OUT = path.join(__dirname, 'out');
const MODELS = path.join(__dirname, '..', 'extension', 'models');

function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, sr = 0, data = null;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = b.readUInt32LE(off + 12);
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  const x = new Float32Array(data.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = data.readInt16LE(i * 2) / 32768;
  return { sr, x };
}

// Bass (20–150 Hz) vs voice band (300–3400 Hz), like the extension's AnalyserNode measurement
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
  const band = (lo, hi) => {
    let e = 0;
    for (let k = Math.max(1, Math.floor(lo * N / sr)); k <= Math.ceil(hi * N / sr); k++) e += re[k] ** 2 + im[k] ** 2;
    return 10 * Math.log10(e + 1e-12);
  };
  return band(20, 150) - band(300, 3400);
}

async function run(mode, { sr, x }, segs, ears) {
  const brain = new AVT.SceneBrain();
  const rs = new AVT.Resampler(sr);
  if (ears) { ears.reset(); ears.onSpeech = (p, dt) => brain.onSpeech(p, dt); ears.onScores = (s) => brain.onScores(s); }
  const step = Math.round(sr * 0.05), out = new Float32Array(x.length), log = [];
  let learnEvent = null;
  for (let i = 0; i + step <= x.length; i += step) {
    const chunk = x.subarray(i, i + step);
    if (ears) await ears.push(rs.process(chunk));
    let e = 0; for (const v of chunk) e += v * v;
    const g = brain.onLevel(10 * Math.log10(e / chunk.length + 1e-12), bassVsVoice(x, i + step, sr), 0.05);
    const lin = 10 ** (g / 20);
    for (let k = 0; k < step; k++) out[i + k] = chunk[k] * lin;
    const t = i / sr;
    // The "user" turns the player down 6 dB during the first fight
    if (mode === 'ai+learned' && !learnEvent && t >= 14) learnEvent = brain.learn(-6, 'player');
    log.push({ t, scene: brain.scene, g });
  }
  const rows = {};
  for (const s of segs) {
    const a = Math.round((s.start + 1.5) * sr), b = Math.round(s.end * sr); // skip 1.5 s settling
    const rms = (arr) => { let e = 0; for (let k = a; k < b; k++) e += arr[k] * arr[k]; return 10 * Math.log10(e / (b - a) + 1e-12); };
    const L = log.filter((r) => r.t >= s.start + 1.5 && r.t < s.end);
    const counts = {};
    L.forEach((r) => (counts[r.scene] = (counts[r.scene] || 0) + 1));
    const top = Object.entries(counts).sort((p, q) => q[1] - p[1])[0];
    rows[s.name + (rows[s.name] ? '#' + s.start : '')] = {
      in: +rms(x).toFixed(1), out: +rms(out).toFixed(1),
      gain: +(L.reduce((p, r) => p + r.g, 0) / L.length).toFixed(1),
      scene: `${top[0]} ${Math.round(100 * top[1] / L.length)}%`, mainScene: top[0]
    };
  }
  return { rows, learnEvent };
}

(async () => {
  const wavPath = path.join(OUT, 'movie.wav');
  if (!fs.existsSync(wavPath)) { console.error('Missing test/out/movie.wav — run: npm run test:audio'); process.exit(1); }
  const wav = readWav(wavPath);
  const segs = fs.readFileSync(path.join(OUT, 'segments.csv'), 'utf8').trim().split('\n').slice(1)
    .map((l) => { const [name, start, end] = l.split(','); return { name, start: +start, end: +end }; });

  const ears = new AVT.Ears(ort);
  await ears.init(fs.readFileSync(path.join(MODELS, 'silero_vad.onnx')), fs.readFileSync(path.join(MODELS, 'yamnet.onnx')));

  const results = {};
  for (const mode of ['basic', 'ai', 'ai+learned']) {
    results[mode] = await run(mode, wav, segs, mode === 'basic' ? null : ears);
    console.log(`\n=== ${mode} ===`);
    console.table(Object.fromEntries(Object.entries(results[mode].rows).map(([k, v]) => [k, { in: v.in, out: v.out, gain: v.gain, scene: v.scene }])));
  }

  const R = (m) => results[m].rows;
  const dlg = (m) => R(m)['dialogue'].out;
  const gap = (m, seg) => +(R(m)[seg].out - dlg(m)).toFixed(1);
  const originalGap = +(R('ai').action.in - R('ai').dialogue.in).toFixed(1);
  const dialogueGains = (m) => Object.entries(R(m)).filter(([k]) => k.startsWith('dialogue')).map(([, v]) => v.gain);
  const s = ears.stats;
  const vadMs = s.vadMs / s.vadRuns, yamMs = s.yamMs / s.yamRuns;

  const checks = [
    [`Fight was ${originalGap} dB louder than dialogue to start with`, originalGap > 15],
    [`Basic mode: fight 1 now ${gap('basic', 'action')} dB above dialogue (< 8)`, gap('basic', 'action') < 8],
    [`AI: fight 1 now ${gap('ai', 'action')} dB above dialogue (< 6)`, gap('ai', 'action') < 6],
    [`AI: fight 2 now ${gap('ai', 'action2')} dB above dialogue (< 6)`, gap('ai', 'action2') < 6],
    [`AI: fight scenes recognised as action (${R('ai').action.scene}, ${R('ai').action2.scene})`, R('ai').action.mainScene === 'action' && R('ai').action2.mainScene === 'action'],
    [`AI: music recognised as music (${R('ai').music.scene})`, R('ai').music.mainScene === 'music'],
    [`AI: whisper lifted (${R('ai').whisper.gain} dB, > 0.5)`, R('ai').whisper.gain > 0.5],
    [`AI: dialogue left alone (avg gains ${dialogueGains('ai').join(', ')} dB, within ±2.5)`, dialogueGains('ai').every((g) => Math.abs(g) < 2.5)],
    [`Learning: stored ${JSON.stringify(results['ai+learned'].learnEvent)}`, results['ai+learned'].learnEvent?.scene === 'action' && results['ai+learned'].learnEvent.value < 0],
    [`Learning: fight 2 gap ${gap('ai', 'action2')} -> ${gap('ai+learned', 'action2')} dB (at least 1.5 dB lower)`, gap('ai+learned', 'action2') <= gap('ai', 'action2') - 1.5],
    [`Learning: music not affected (${R('ai').music.gain} -> ${R('ai+learned').music.gain} dB)`, Math.abs(R('ai').music.gain - R('ai+learned').music.gain) < 0.5],
    [`Speed: speech model ${vadMs.toFixed(2)} ms per 32 ms frame (< 5)`, vadMs < 5],
    [`Speed: YAMNet ${yamMs.toFixed(1)} ms per 480 ms window (< 100)`, yamMs < 100]
  ];
  console.log('\nChecks:');
  let failed = 0;
  for (const [label, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; }
  console.log(failed ? `\n${failed} check(s) FAILED` : `\nAll ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
