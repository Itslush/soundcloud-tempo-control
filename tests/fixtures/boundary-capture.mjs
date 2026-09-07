registerProcessor(
  'boundary-capture',
  class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const frames = options.processorOptions?.frames;
      if (
        !Number.isInteger(frames) ||
        frames < 128 ||
        frames > sampleRate * 5 ||
        frames % 128
      )
        throw new Error('Capture length must be bounded whole render quanta');
      this.frames = frames;
      this.pcm = new Float32Array(frames * 4);
      this.timestamps = new Float64Array(frames / 128);
      this.inputChannels = new Uint8Array((frames / 128) * 2);
      this.cursor = 0;
      this.armed = false;
      this.port.onmessage = ({ data }) => {
        if (data === 'start' && !this.armed && this.cursor === 0)
          this.armed = true;
      };
    }

    process(inputs) {
      if (!this.armed) return true;
      const quantum = this.cursor / 128;
      this.timestamps[quantum] = currentFrame;
      if (!this.cursor)
        this.port.postMessage({ type: 'started', frame: currentFrame });
      for (let input = 0; input < 2; input++) {
        const channels = inputs[input] || [];
        this.inputChannels[quantum * 2 + input] = channels.length;
        for (let channel = 0; channel < 2; channel++) {
          const samples = channels[Math.min(channel, channels.length - 1)];
          for (let frame = 0; frame < 128; frame++)
            this.pcm[(this.cursor + frame) * 4 + input * 2 + channel] =
              samples?.[frame] ?? 0;
        }
      }
      this.cursor += 128;
      if (this.cursor < this.frames) return true;
      this.port.postMessage(
        {
          type: 'complete',
          frames: this.frames,
          pcm: this.pcm,
          timestamps: this.timestamps,
          inputChannels: this.inputChannels,
        },
        [this.pcm.buffer, this.timestamps.buffer, this.inputChannels.buffer],
      );
      this.pcm = null;
      this.timestamps = null;
      this.inputChannels = null;
      this.port.close();
      return false;
    }
  },
);
