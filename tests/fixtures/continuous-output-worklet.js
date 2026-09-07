registerProcessor('tempo-continuous-output', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.start = null;
    this.end = null;
    this.frames = 0;
    this.gaps = 0;
    this.nonfinite = 0;
    this.silentFrames = 0;
    this.silentRun = 0;
    this.longestSilentRun = 0;
    this.peak = 0;
    this.port.onmessage = () => this.port.postMessage({
      sampleRate, start: this.start, end: this.end, frames: this.frames,
      gaps: this.gaps, nonfinite: this.nonfinite, silentFrames: this.silentFrames,
      longestSilentRun: this.longestSilentRun, peak: this.peak,
    });
  }

  process(inputs, outputs) {
    const length = outputs[0][0].length;
    if (this.start === null) this.start = currentFrame;
    if (this.end !== null && this.end !== currentFrame) this.gaps++;
    for (let index = 0; index < length; index++) {
      let silent = true;
      for (const channel of inputs[0]) {
        const sample = channel[index];
        if (!Number.isFinite(sample)) this.nonfinite++;
        else this.peak = Math.max(this.peak, Math.abs(sample));
        if (sample !== 0) silent = false;
      }
      if (silent) {
        this.silentFrames++;
        this.longestSilentRun = Math.max(this.longestSilentRun, ++this.silentRun);
      } else this.silentRun = 0;
    }
    this.frames += length;
    this.end = currentFrame + length;
    return true;
  }
});
