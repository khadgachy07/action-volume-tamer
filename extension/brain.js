// brain.js — the extension's decision-making, shared by the extension and the test harness.
//
//   Resampler   : converts captured audio to 16 kHz for the models
//   Ears        : runs the two on-device AI models
//                 - Silero VAD  -> "is someone talking right now?" (every 32 ms)
//                 - YAMNet      -> 521 sound types, e.g. Explosion, Gunshot, Music (every 0.48 s)
//   SceneBrain  : fuses model outputs + loudness into a scene and a volume adjustment,
//                 and learns from the user's own volume corrections.
//
// Works as a classic <script> (exposes globalThis.AVT) and as a Node module.

(function (root) {
  'use strict';

  // ---------- YAMNet class groups (indices into the 521-class map) ----------
  // weight = how strongly that sound implies "action"
  const ACTION_CLASSES = [
    [420, 1.0, 'Explosion'], [421, 1.0, 'Gunshot'], [422, 1.0, 'Machine gun'],
    [423, 1.0, 'Gunfire'], [424, 1.0, 'Artillery'], [425, 0.7, 'Cap gun'],
    [426, 0.8, 'Fireworks'], [427, 0.7, 'Firecracker'], [428, 0.6, 'Burst'],
    [429, 0.9, 'Eruption'], [430, 1.0, 'Boom'], [281, 0.7, 'Thunder'],
    [280, 0.5, 'Thunderstorm'], [463, 0.8, 'Crash'], [464, 0.6, 'Breaking'],
    [437, 0.6, 'Shatter'], [460, 0.7, 'Bang'], [352, 0.5, 'Slam'],
    [454, 0.4, 'Thud'], [434, 0.4, 'Crack'], [466, 0.4, 'Whip'],
    [306, 0.6, 'Skidding'], [307, 0.6, 'Tire squeal'], [309, 0.6, 'Race car'],
    [347, 0.6, 'Engine revving'], [343, 0.4, 'Heavy engine'], [331, 0.6, 'Jet engine'],
    [330, 0.5, 'Aircraft'], [333, 0.6, 'Helicopter'], [390, 0.4, 'Siren'],
    [317, 0.4, 'Police siren'], [11, 0.5, 'Screaming'], [105, 0.5, 'Roar']
  ];
  const SPEECH_CLASSES = [0, 2, 3, 12];      // Speech, Conversation, Narration, Whispering
  const SHOUT_CLASSES = [6, 9, 10];          // Shout, Yell, Children shouting
  const MUSIC_CLASS = 132;
  const YAMNET_WINDOW = 15600;               // 0.975 s at 16 kHz
  const YAMNET_HOP = 7680;                   // 0.48 s
  const VAD_FRAME = 512;                     // 32 ms at 16 kHz
  const VAD_CONTEXT = 64;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const ema = (dt, tau) => 1 - Math.exp(-dt / tau);

  // ---------- Resampler: windowed-sinc, any rate -> 16 kHz ----------
  class Resampler {
    constructor(inRate, outRate = 16000, halfTaps = 12) {
      this.ratio = inRate / outRate;                     // input samples per output sample
      this.fc = (0.5 / Math.max(1, this.ratio)) * 0.92;  // low-pass cutoff (cycles / input sample)
      this.H = Math.ceil(halfTaps * Math.max(1, this.ratio));
      this.buf = new Float32Array(0);
      this.pos = this.H;
    }
    kernel(x) {
      const a = 2 * this.fc * x;
      const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
      return sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / this.H));
    }
    process(input) {
      const buf = new Float32Array(this.buf.length + input.length);
      buf.set(this.buf); buf.set(input, this.buf.length);
      const out = [];
      let pos = this.pos;
      const H = this.H;
      while (pos + H < buf.length) {
        const c = Math.floor(pos), frac = pos - c;
        let acc = 0, wsum = 0;
        for (let k = -H + 1; k <= H; k++) {
          const w = this.kernel(k - frac);
          acc += buf[c + k] * w; wsum += w;
        }
        out.push(acc / wsum);
        pos += this.ratio;
      }
      const keepFrom = Math.max(0, Math.floor(pos) - H);
      this.buf = buf.slice(keepFrom);
      this.pos = pos - keepFrom;
      return Float32Array.from(out);
    }
  }

  // ---------- Ears: the two AI models ----------
  class Ears {
    constructor(ort) {
      this.ort = ort;
      this.onSpeech = () => {};
      this.onScores = () => {};
      this.vadQueue = [];
      this.vadPending = new Float32Array(0);
      this.yamBuf = new Float32Array(YAMNET_WINDOW);
      this.yamFilled = 0;
      this.sinceYam = 0;
      this.yamPending = null;
      this.chain = Promise.resolve();
      this.stats = { vadMs: 0, yamMs: 0, vadRuns: 0, yamRuns: 0 };
    }

    async init(vadModel, yamModel) {
      const ort = this.ort;
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      this.vad = await ort.InferenceSession.create(vadModel, opts);
      this.yam = await ort.InferenceSession.create(yamModel, opts);
      this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
      this.resetVad();
    }

    resetVad() {
      this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
      this.ctx = new Float32Array(VAD_CONTEXT);
    }

    // Forget buffered audio (new tab / restart)
    reset() {
      this.vadQueue = [];
      this.vadPending = new Float32Array(0);
      this.yamBuf = new Float32Array(YAMNET_WINDOW);
      this.yamFilled = 0;
      this.sinceYam = 0;
      this.yamPending = null;
      this.resetVad();
    }

    // Feed 16 kHz mono samples. Returns a promise that settles when they're analysed.
    push(samples) {
      // VAD frames
      const p = new Float32Array(this.vadPending.length + samples.length);
      p.set(this.vadPending); p.set(samples, this.vadPending.length);
      let off = 0;
      while (off + VAD_FRAME <= p.length) { this.vadQueue.push(p.slice(off, off + VAD_FRAME)); off += VAD_FRAME; }
      this.vadPending = p.slice(off);
      if (this.vadQueue.length > 30) { this.vadQueue = this.vadQueue.slice(-8); this.resetVad(); } // fell behind: skip ahead

      // YAMNet sliding window
      if (samples.length >= YAMNET_WINDOW) {
        this.yamBuf.set(samples.subarray(samples.length - YAMNET_WINDOW));
      } else {
        this.yamBuf.copyWithin(0, samples.length);
        this.yamBuf.set(samples, YAMNET_WINDOW - samples.length);
      }
      this.yamFilled = Math.min(YAMNET_WINDOW, this.yamFilled + samples.length);
      this.sinceYam += samples.length;
      if (this.yamFilled === YAMNET_WINDOW && this.sinceYam >= YAMNET_HOP) {
        this.sinceYam = 0;
        this.yamPending = this.yamBuf.slice(); // only ever keep the newest window
      }
      return (this.chain = this.chain.then(() => this.drain()).catch((e) => console.warn('AVT inference', e)));
    }

    async drain() {
      const ort = this.ort;
      while (this.vadQueue.length) {
        const frame = this.vadQueue.shift();
        const input = new Float32Array(VAD_CONTEXT + VAD_FRAME);
        input.set(this.ctx); input.set(frame, VAD_CONTEXT);
        this.ctx = frame.slice(-VAD_CONTEXT);
        const t0 = now();
        const out = await this.vad.run({ input: new ort.Tensor('float32', input, [1, input.length]), state: this.state, sr: this.sr });
        this.stats.vadMs += now() - t0; this.stats.vadRuns++;
        this.state = out.stateN;
        this.onSpeech(out.output.data[0], VAD_FRAME / 16000);
      }
      if (this.yamPending) {
        const win = this.yamPending; this.yamPending = null;
        const t0 = now();
        const out = await this.yam.run({ [this.yam.inputNames[0]]: new ort.Tensor('float32', win, [YAMNET_WINDOW]) });
        this.stats.yamMs += now() - t0; this.stats.yamRuns++;
        this.onScores(out[this.yam.outputNames[0]].data);
      }
    }
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---------- SceneBrain: decisions + learning ----------
  const DEFAULT_SETTINGS = { maxCut: 12, boost: 4, threshold: 6 };
  const DEFAULT_PREFS = { action: 0, music: 0, ambient: 0, quiet: 0, adjustments: 0 };

  class SceneBrain {
    constructor(settings, prefs) {
      this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
      this.prefs = { ...DEFAULT_PREFS, ...(prefs || {}) };
      this.reset();
    }

    reset() {
      this.aiReady = false;
      this.speech = 0;          // smoothed speech probability (Silero)
      this.yamSpeech = 0;
      this.shout = 0;
      this.action = 0;          // 0..1, decays slowly so a fight stays "a fight" between bangs
      this.music = 0;
      this.topSound = '';
      this.baseline = null;     // learned dialogue loudness (dBFS)
      this.speechWarmup = [];
      this.fbBaseline = null;   // non-AI fallback baseline
      this.fbWarmup = [];
      this.level = -90;
      this.hold = -90;          // peak-hold loudness, so the volume stays down between explosions
      this.gainDb = 0;
      this.scene = 'learning';
      this.t = 0;
      this.lastSeen = { action: -1e9, quiet: -1e9, music: -1e9, ambient: -1e9 };
    }

    // Silero VAD probability for one 32 ms frame
    onSpeech(p, dt) {
      this.speech += (p - this.speech) * ema(dt, 0.25);
    }

    // YAMNet scores (521) for the latest ~1 s window
    onScores(s) {
      this.aiReady = true;
      let notAction = 1, best = 0;
      for (const [i, w] of ACTION_CLASSES) {
        const v = w * s[i];
        notAction *= 1 - v;
        if (v > best) { best = v; this.topSound = ACTION_CLASSES.find((c) => c[0] === i)[2]; }
      }
      const actionNow = 1 - notAction;
      // rise instantly, fall over a few seconds
      this.action = Math.max(actionNow, this.action);
      this.music += (s[MUSIC_CLASS] - this.music) * 0.5;
      this.yamSpeech = Math.max(...SPEECH_CLASSES.map((i) => s[i]));
      this.shout = Math.max(...SHOUT_CLASSES.map((i) => s[i]));
      if (best < 0.15) this.topSound = '';
    }

    // Called ~20x/s with the source loudness. Returns the gain to apply (dB).
    onLevel(levelDb, bassVsVoice, dt) {
      this.t += dt;
      this.level += (levelDb - this.level) * ema(dt, 0.3);
      this.action *= Math.exp(-dt / 2.5);
      const L = this.level;
      const silent = L < -60;
      const s = this.settings;
      this.hold = Math.max(L, this.hold - 3 * dt); // falls 3 dB per second

      // Fallback baseline (pure loudness) — used until speech has been heard
      if (!silent) {
        if (this.fbBaseline === null) {
          this.fbWarmup.push(L);
          if (this.fbWarmup.length >= 40) {
            const sorted = [...this.fbWarmup].sort((a, b) => a - b);
            this.fbBaseline = sorted[Math.floor(sorted.length * 0.4)];
          }
        } else {
          const ex = L - (this.fbBaseline + s.threshold);
          if (ex <= 0 && L > this.fbBaseline - 12) this.fbBaseline += (L - this.fbBaseline) * ema(dt, 10);
          else if (ex > 0 && bassVsVoice < 8) this.fbBaseline += (L - this.fbBaseline) * ema(dt, 30);
        }
      }

      // AI baseline: learn dialogue loudness only while someone is clearly talking
      const talking = this.speech > 0.6 && this.action < 0.25 && this.music < 0.6;
      if (this.aiReady && talking && !silent) {
        if (this.baseline === null) {
          this.speechWarmup.push(L);
          if (this.speechWarmup.length >= 30) { // ~1.5 s of speech
            const sorted = [...this.speechWarmup].sort((a, b) => a - b);
            this.baseline = sorted[Math.floor(sorted.length / 2)];
          }
        } else {
          this.baseline += (L - this.baseline) * ema(dt, 8);
        }
      }

      const base = this.baseline ?? this.fbBaseline;
      let target = 0;
      let attack = 0.2, release = 2.0;

      if (base === null) {
        this.scene = 'learning';
      } else if (silent) {
        this.scene = 'silence';
        target = Math.min(this.gainDb, 0); // hold, never boost silence/noise
      } else {
        // Second opinion: loud + booming sub-bass is action even if YAMNet is unsure
        if (this.aiReady && bassVsVoice > 8 && L > base + s.threshold && this.music < 0.5) {
          this.action = Math.max(this.action, 0.5);
          if (!this.topSound) this.topSound = 'Heavy bass';
        }

        // --- what kind of scene is this? ---
        if (!this.aiReady) {
          const ex = L - (base + s.threshold);
          this.scene = ex > 0 ? 'action' : (L < base - 4 ? 'quiet' : 'dialogue');
          if (ex > 0 && bassVsVoice > 8) this.topSound = 'Heavy bass';
        } else if (this.action > 0.35) this.scene = 'action';
        else if (this.speech > 0.5) this.scene = L < base - 4 ? 'quiet' : 'dialogue';
        else if (this.music > 0.5) this.scene = 'music';
        else this.scene = 'ambient';

        // --- how loud may it be? ---
        let ceiling = base + s.threshold;
        if (this.scene === 'action' && this.aiReady) ceiling = base + s.threshold * 0.5; // confirmed action: hold closer to dialogue
        const talkingNow = this.scene === 'dialogue' || this.scene === 'quiet';
        if (talkingNow) this.hold = L;                 // dialogue: react to the actual level
        let cut = Math.max(0, (talkingNow ? L : this.hold) - ceiling);
        if (this.scene === 'dialogue' && (this.shout > 0.3 || this.speech > 0.8)) cut *= 0.6; // let shouted lines stay a bit louder
        if (!this.aiReady && bassVsVoice > 8 && cut > 0) cut += 3;

        let lift = 0;
        if (this.scene === 'quiet' && (!this.aiReady || this.speech > 0.5)) lift = Math.min(s.boost, (base - 3 - L) * 0.7);

        // --- what this user taught it ---
        const learned = this.prefs[this.scene] || 0;
        const loudEnough = clamp((L - (base - 6)) / 6, 0, 1); // don't cut already-quiet scenes
        const pref = learned < 0 ? learned * loudEnough : learned;

        const maxCut = s.maxCut + Math.max(0, -(this.prefs[this.scene] || 0)); // learned extra room only for that scene type
        const maxLift = s.boost + Math.max(0, this.prefs.quiet);
        target = clamp(-cut + lift + pref, -maxCut, maxLift);
        if (target > 0 && this.scene !== 'quiet') target = Math.min(target, Math.max(0, pref));
        if (this.scene === 'action') attack = this.aiReady ? 0.08 : 0.15;
        if (this.t - this.lastSeen.action < 3) release = 3.0;
        if (this.aiReady && this.scene === 'dialogue' && this.speech > 0.6) release = 1.0; // dialogue is back: restore quickly
        if (this.scene in this.lastSeen) this.lastSeen[this.scene] = this.t;
      }

      const tau = target < this.gainDb ? attack : release;
      this.gainDb += (target - this.gainDb) * ema(dt, tau);
      return this.gainDb;
    }

    // Re-learn the dialogue level (new movie)
    relearn() {
      this.baseline = null; this.speechWarmup = [];
      this.fbBaseline = null; this.fbWarmup = [];
      this.gainDb = 0;
    }

    forget() {
      this.prefs = { ...DEFAULT_PREFS };
    }

    // The user changed volume by `delta` dB (negative = quieter).
    // source: 'player' (site's volume control) or 'key' (shortcut / popup button)
    learn(delta, source) {
      const recent = (k, secs) => this.t - this.lastSeen[k] < secs;
      let scene = this.scene;
      if (delta < 0) {
        // Turning down: blame the loud thing you just heard (people react a second or two late)
        if (recent('action', 4)) scene = 'action';
        else if (recent('music', 3)) scene = 'music';
      } else {
        // Turning up right after a fight = undoing the earlier turn-down, not a preference
        if (recent('action', 6) && scene !== 'action') return null;
        if (scene === 'quiet' || (recent('quiet', 3) && scene !== 'action')) scene = 'quiet';
      }
      if (!(scene in DEFAULT_PREFS) || scene === 'adjustments') return null; // dialogue/silence = just normal master volume
      const rate = source === 'key' ? 1 : 0.5;
      this.prefs[scene] = Math.round(clamp(this.prefs[scene] + rate * delta, -12, 12) * 10) / 10;
      this.prefs.adjustments++;
      return { scene, value: this.prefs[scene] };
    }

    status() {
      return {
        scene: this.scene, gainDb: this.gainDb, levelDb: this.level,
        baselineDb: this.baseline ?? this.fbBaseline,
        aiReady: this.aiReady, speech: this.speech, action: this.action, music: this.music,
        topSound: this.topSound, prefs: { ...this.prefs }
      };
    }
  }

  const api = { Resampler, Ears, SceneBrain, DEFAULT_SETTINGS, DEFAULT_PREFS, YAMNET_WINDOW, VAD_FRAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AVT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
