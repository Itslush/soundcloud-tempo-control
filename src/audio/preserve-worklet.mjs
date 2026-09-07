export function registerPreserveProcessor(Module, name) {
  const QUANTUM = 128;
  const fail = (message) => {
    throw new Error(message);
  };
  const frame = (value) => Number.isSafeInteger(value) && value >= 0;

  class PreserveProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const settings = options.processorOptions;
      this.sourceRate = settings.sourceSampleRate;
      this.maxBytes = settings.maxBufferBytes;
      this.maxWindows = settings.maxWindows;
      this.generation = settings.generation;
      this.windows = [];
      this.buffers = [];
      this.bufferBytes = 0;
      this.peakBufferBytes = 0;
      this.ready = false;
      this.disposed = false;
      this.failed = false;
      this.lastEnd = null;
      this.totalFrames = undefined;
      if (
        !Number.isInteger(this.sourceRate) ||
        this.sourceRate < 8000 ||
        this.sourceRate > 192000 ||
        !frame(this.generation) ||
        !Number.isSafeInteger(this.maxBytes) ||
        this.maxBytes < 8192 ||
        !Number.isSafeInteger(this.maxWindows) ||
        this.maxWindows < 1 ||
        this.maxWindows > 32
      )
        fail('Invalid preserved processor configuration');
      this.port.onmessage = (event) => this.message(event.data);
      Module()
        .then((wasm) => {
          if (this.disposed) return;
          this.wasm = wasm;
          wasm._main();
          wasm._configure(
            2,
            Math.round(sampleRate * 0.12),
            Math.round(sampleRate * 0.03),
            true,
          );
          wasm._reset();
          this.inputLatency = wasm._inputLatency();
          this.outputLatency = wasm._outputLatency();
          this.historyLength = this.inputLatency + this.outputLatency;
          if (
            !frame(this.inputLatency) ||
            !frame(this.outputLatency) ||
            this.historyLength < QUANTUM ||
            this.historyLength > sampleRate
          )
            fail('Invalid Signalsmith working-buffer size');
          this.pointer = wasm._setBuffers(2, this.historyLength);
          wasm._setTransposeFactor(
            this.sourceRate / sampleRate,
            8000 / sampleRate,
          );
          wasm._setFormantSemitones(0, false);
          wasm._setFormantBase(0);
          this.ready = true;
          this.port.postMessage({ type: 'ready', ...this.stats() });
        })
        .catch((error) => this.fatal(error));
    }

    stats() {
      return {
        generation: this.generation,
        disposed: this.disposed,
        failed: this.failed,
        bufferBytes: this.bufferBytes,
        peakBufferBytes: this.peakBufferBytes,
        buffers: this.buffers.length,
        windows: this.windows.length,
        inputLatencyFrames: this.inputLatency,
        outputLatencyFrames: this.outputLatency,
        historyFrames: this.historyLength,
        heapBytes: this.wasm?.HEAP8.buffer.byteLength,
        bufferStartFrame: this.buffers[0]?.start,
        bufferEndFrame: this.buffers.at(-1)?.end,
      };
    }

    fatal(error) {
      this.failed = true;
      this.windows.length = 0;
      this.dropBuffers();
      this.port.postMessage({
        type: 'failure',
        generation: this.generation,
        message: error.message,
      });
    }

    dropBuffers(before) {
      while (
        this.buffers.length &&
        (before === undefined || this.buffers[0].end <= before)
      ) {
        const block = this.buffers.shift();
        this.bufferBytes -= (block.end - block.start) * 8;
        block.channels.length = 0;
      }
    }

    addBuffers(start, channels) {
      if (!channels.length) return;
      if (
        !frame(start) ||
        channels.length !== 2 ||
        channels.some(
          (channel) =>
            !(channel instanceof Float32Array) ||
            channel.byteOffset !== 0 ||
            channel.byteLength !== channel.buffer.byteLength,
        ) ||
        !channels[0].length ||
        channels[0].length !== channels[1].length
      )
        fail('Invalid preserved PCM block');
      const length = channels[0].length;
      const end = start + length;
      if (
        !frame(end) ||
        channels.some((channel) => !channel.every(Number.isFinite))
      )
        fail('Preserved PCM must be finite and frame-bounded');
      const previous = this.buffers.at(-1);
      if (previous && previous.end !== start)
        fail('Preserved PCM blocks must be contiguous');
      if (this.bufferBytes + length * 8 > this.maxBytes)
        fail('Preserved PCM byte budget exceeded');
      this.buffers.push({ start, end, channels });
      this.bufferBytes += length * 8;
      this.peakBufferBytes = Math.max(this.peakBufferBytes, this.bufferBytes);
    }

    validateWindow(window) {
      const {
        outputStartFrame: start,
        outputEndFrame: end,
        sourceStartFrame,
        sourceEndFrame,
        intervals,
      } = window;
      if (
        !frame(start) ||
        start % QUANTUM ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > sampleRate * 2 ||
        start < currentFrame + this.outputLatency + QUANTUM ||
        !Number.isFinite(sourceStartFrame) ||
        sourceStartFrame < 0 ||
        !Number.isFinite(sourceEndFrame) ||
        sourceEndFrame <= sourceStartFrame ||
        sourceEndFrame > this.sourceRate * 86400 ||
        !Array.isArray(intervals) ||
        !intervals.length ||
        intervals.length > Math.ceil((sampleRate * 2) / QUANTUM)
      )
        fail('Invalid or late preserved playback window');
      let position = sourceStartFrame;
      for (let index = 0; index < intervals.length; index++) {
        const interval = intervals[index];
        const effective = (interval.rate * this.sourceRate) / sampleRate;
        if (
          interval.outputFrame !== start + index * QUANTUM ||
          interval.sourceFrame !== position ||
          !Number.isFinite(interval.rate) ||
          interval.rate < 0.025 ||
          interval.rate > 4 ||
          Math.fround(interval.rate) !== interval.rate ||
          interval.sourceFramesPerOutputFrame !== effective
        )
          fail('Invalid preserved rate-clock interval');
        position += QUANTUM * effective;
      }
      if (
        start + intervals.length * QUANTUM < end ||
        Math.abs(this.sourceAt(window, end) - sourceEndFrame) > 0.000001
      )
        fail('Preserved rate-clock endpoint mismatch');
      if (this.lastEnd !== null && start < this.lastEnd)
        fail('Preserved windows overlap');
      if (this.windows.length >= this.maxWindows)
        fail('Preserved schedule budget exceeded');
    }

    sourceAt(window, outputFrame) {
      const index = Math.max(
        0,
        Math.min(
          window.intervals.length - 1,
          Math.floor((outputFrame - window.outputStartFrame) / QUANTUM),
        ),
      );
      const interval = window.intervals[index];
      return (
        interval.sourceFrame +
        (outputFrame - interval.outputFrame) *
          interval.sourceFramesPerOutputFrame
      );
    }

    message(message) {
      const { id, generation, method, value } = message;
      try {
        if (
          !this.ready ||
          this.disposed ||
          (this.failed && method !== 'dispose')
        )
          fail('Preserved processor is not available');
        if (method === 'reset' || method === 'dispose') {
          if (!frame(generation) || generation <= this.generation)
            fail('Invalid preserved reset generation');
          this.generation = generation;
          this.windows.length = 0;
          this.dropBuffers();
          this.lastEnd = null;
          this.totalFrames = undefined;
          this.wasm._reset();
          this.disposed = method === 'dispose';
        } else {
          if (generation !== this.generation)
            fail('Stale preserved processor generation');
          if (method === 'schedule') {
            this.validateWindow(value.window);
            if (value.totalSourceFrames !== undefined) {
              if (
                !frame(value.totalSourceFrames) ||
                !value.totalSourceFrames ||
                (this.totalFrames !== undefined &&
                  this.totalFrames !== value.totalSourceFrames)
              )
                fail('Invalid preserved EOF');
              this.totalFrames = value.totalSourceFrames;
            }
            this.addBuffers(value.pcmStartFrame, value.channels);
            this.windows.push(value.window);
            this.lastEnd = value.window.outputEndFrame;
          } else if (method === 'truncate') {
            const cut = value;
            if (
              !frame(cut) ||
              cut % QUANTUM ||
              cut < currentFrame + this.outputLatency + QUANTUM ||
              !this.windows.some(
                (window) =>
                  window.outputStartFrame <= cut &&
                  cut <= window.outputEndFrame,
              )
            )
              fail('Invalid or late preserved truncation');
            this.windows = this.windows.filter(
              (window) => window.outputStartFrame < cut,
            );
            const last = this.windows.at(-1);
            if (last && last.outputEndFrame > cut) {
              last.sourceEndFrame = this.sourceAt(last, cut);
              last.outputEndFrame = cut;
            }
            this.lastEnd = cut;
          } else fail('Unknown preserved processor method');
        }
        this.port.postMessage({
          type: 'reply',
          id,
          generation,
          value: this.stats(),
        });
      } catch (error) {
        this.port.postMessage({
          type: 'reply',
          id,
          generation,
          error: error.message,
        });
      }
    }

    updateViews() {
      const heap = this.wasm.HEAP8.buffer;
      if (heap === this.heap) return;
      this.heap = heap;
      this.inputViews = [0, 1].map(
        (channel) =>
          new Float32Array(
            heap,
            this.pointer + channel * this.historyLength * 4,
            this.historyLength,
          ),
      );
      this.outputViews = [0, 1].map(
        (channel) =>
          new Float32Array(
            heap,
            this.pointer + (channel + 2) * this.historyLength * 4,
            QUANTUM,
          ),
      );
    }

    copyHistory(end) {
      const start = end - this.historyLength;
      this.updateViews();
      const channels = this.inputViews;
      const requiredStart = Math.max(0, start);
      const requiredEnd =
        this.totalFrames === undefined ? end : Math.min(end, this.totalFrames);
      for (const channel of channels) {
        if (start < 0) channel.fill(0, 0, Math.min(this.historyLength, -start));
        if (requiredEnd < end) channel.fill(0, Math.max(0, requiredEnd - start));
      }
      let cursor = requiredStart;
      for (const block of this.buffers) {
        if (block.end <= cursor) continue;
        if (block.start >= requiredEnd) break;
        if (block.start > cursor)
          fail('Preserved PCM history has a coverage gap');
        const to = Math.min(block.end, requiredEnd);
        const offset = cursor - start;
        const length = to - cursor;
        if (offset < 0 || offset + length > this.historyLength)
          fail('Preserved history cursor is out of bounds');
        for (let channel = 0; channel < 2; channel++)
          channels[channel].set(
            block.channels[channel].subarray(
              cursor - block.start,
              to - block.start,
            ),
            offset,
          );
        cursor = to;
        if (cursor >= requiredEnd) break;
      }
      if (cursor < requiredEnd) fail('Preserved PCM history is incomplete');
      this.dropBuffers(requiredStart - QUANTUM);
    }

    process(inputs, outputs) {
      const channels = outputs[0];
      if (!channels?.length) return false;
      for (const channel of channels) channel.fill(0);
      if (this.disposed) return false;
      if (!this.ready || this.failed || !this.windows.length) return true;
      try {
        if (
          channels.length !== 2 ||
          channels.some((channel) => channel.length !== QUANTUM)
        )
          fail('Preserved output must remain stereo render quanta');
        while (
          this.windows.length &&
          this.windows[0].outputEndFrame <= currentFrame
        )
          this.windows.shift();
        if (!this.windows.length) {
          this.wasm._reset();
          this.port.postMessage({ type: 'stats', value: this.stats() });
          return true;
        }
        const analysisFrame = currentFrame + this.outputLatency;
        const first = this.windows[0];
        if (analysisFrame < first.outputStartFrame) return true;
        const window = this.windows.findLast(
          (value) => value.outputStartFrame <= analysisFrame,
        );
        const index = Math.max(
          0,
          Math.min(
            window.intervals.length - 1,
            Math.floor((analysisFrame - window.outputStartFrame) / QUANTUM),
          ),
        );
        const rate =
          (window.intervals[index].rate * this.sourceRate) / sampleRate;
        const sourceEnd = Math.round(
          this.sourceAt(window, analysisFrame) + this.inputLatency,
        );
        this.copyHistory(sourceEnd);
        this.wasm._seek(this.historyLength, rate);
        this.wasm._process(0, QUANTUM);
        this.updateViews();
        for (let channel = 0; channel < 2; channel++) {
          const result = this.outputViews[channel];
          if (!result.every(Number.isFinite))
            fail('Preserved output is not finite');
          channels[channel].set(result);
        }
      } catch (error) {
        for (const channel of channels) channel.fill(0);
        this.fatal(error);
      }
      return true;
    }
  }

  registerProcessor(name, PreserveProcessor);
}
