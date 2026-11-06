// AudioWorklet: copies the tab's audio (mono mix) to the main thread for the AI models.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const len = chans[0].length, nc = chans.length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < nc; c++) s += chans[c][i];
        this.buf[this.n++] = s / nc;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
