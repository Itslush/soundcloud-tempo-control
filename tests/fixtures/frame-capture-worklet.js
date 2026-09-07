registerProcessor('tempo-frame-capture', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(sampleRate * 2);
    this.start = currentFrame;
    this.end = currentFrame;
    this.port.onmessage = ({ data }) => {
      const { id, start, length } = data;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length < 1 ||
          length > this.buffer.length || start < Math.max(this.start, this.end - this.buffer.length) ||
          start + length > this.end) {
        this.port.postMessage({ id, error: 'Requested frames are outside retained capture', start: this.start, end: this.end });
        return;
      }
      const samples = new Float32Array(length);
      for (let index = 0; index < length; index++)
        samples[index] = this.buffer[(start + index) % this.buffer.length];
      this.port.postMessage({ id, start, samples }, [samples.buffer]);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const length = outputs[0][0].length;
    for (let index = 0; index < length; index++)
      this.buffer[(currentFrame + index) % this.buffer.length] = input?.[index] ?? 0;
    this.end = currentFrame + length;
    return true;
  }
});
