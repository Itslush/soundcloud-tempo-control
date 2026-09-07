globalThis.runPreserveOutputProbe = async ({
  sourceRate,
  outputRate,
  rate,
  chirp = false,
  capturePcm = false,
}) => {
  const result = {
    sourceRate,
    outputRate,
    rate,
    chirp,
    status: 'INCOMPLETE',
    failures: [],
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const context = new AudioContext({ sampleRate: outputRate });
  const analyser = context.createAnalyser();
  analyser.fftSize = 16384;
  analyser.smoothingTimeConstant = 0;
  const silence = context.createGain();
  silence.gain.value = 0;
  silence.connect(context.destination);
  const captureSource = `registerProcessor('preserve-probe-capture', class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.rows = [];
      this.pcm = options.processorOptions.capturePcm ? new Float32Array(sampleRate * 3) : null;
      this.length = 0;
      this.firstFrame = null;
      this.port.onmessage = () => this.port.postMessage({
        rows: this.rows,
        pcm: this.pcm ? { firstFrame: this.firstFrame, sampleRate, samples: Array.from(this.pcm.subarray(0, this.length)) } : null,
      });
    }
    process(inputs, outputs) {
      const channels = inputs[0];
      if (this.pcm && this.length < this.pcm.length) {
        this.firstFrame ??= currentFrame;
        const offset = currentFrame - this.firstFrame;
        const count = Math.min(128, this.pcm.length - offset);
        if (count > 0) {
          if (channels[0]) this.pcm.set(channels[0].subarray(0, count), offset);
          this.length = offset + count;
        }
      }
      let peak = 0, first = null;
      for (let channel = 0; channel < outputs[0].length; channel++) {
        const source = channels[channel];
        if (!source) continue;
        outputs[0][channel].set(source);
        for (let index = 0; index < source.length; index++) {
          const value = Math.abs(source[index]);
          peak = Math.max(peak, value);
          if (value > 0.000001) first = Math.min(first ?? index, index);
        }
      }
      if (this.rows.length < 6000) this.rows.push({ frame: currentFrame, peak, first });
      return true;
    }
  });`;
  const captureUrl = URL.createObjectURL(
    new Blob([captureSource], { type: 'text/javascript' }),
  );
  try {
    await context.audioWorklet.addModule(captureUrl);
  } finally {
    URL.revokeObjectURL(captureUrl);
  }
  const capture = new AudioWorkletNode(context, 'preserve-probe-capture', {
    outputChannelCount: [2],
    processorOptions: { capturePcm },
  });
  async function readCapture() {
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Capture read timed out')), 1000);
        capture.port.onmessage = (event) => resolve(event.data);
        capture.port.postMessage('read');
      });
    } finally {
      clearTimeout(timer);
    }
  }
  analyser.connect(capture);
  capture.connect(silence);
  const moduleSource = await (await fetch('/worklet.js')).text();
  const output = createPreserveOutput({
    context,
    destination: analyser,
    moduleSource,
  });
  output.subscribeFailure((error) => result.failures.push(error.message));
  const tone = 960;
  const quantum = 128;
  const align = (frame) => Math.ceil(frame / quantum) * quantum;
  const frameCount = Math.floor((outputRate * 0.25) / quantum) * quantum;
  const data = new Float32Array(analyser.fftSize);
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  function measure() {
    const captureStartedAt = performance.now();
    const contextBeforeCapture = context.currentTime;
    analyser.getFloatTimeDomainData(data);
    const contextAfterCapture = context.currentTime;
    analyser.getFloatFrequencyData(spectrum);
    let bin = 1;
    for (let index = 2; index < spectrum.length - 1; index++)
      if (spectrum[index] > spectrum[bin]) bin = index;
    const denominator =
      spectrum[bin - 1] - 2 * spectrum[bin] + spectrum[bin + 1];
    const offset =
      Number.isFinite(denominator) && denominator !== 0
        ? Math.max(
            -0.5,
            Math.min(
              0.5,
              (0.5 * (spectrum[bin - 1] - spectrum[bin + 1])) / denominator,
            ),
          )
        : 0;
    let energy = 0,
      peak = 0,
      invalid = 0,
      crossings = 0,
      first,
      last;
    for (let index = 0; index < data.length; index++) {
      if (!Number.isFinite(data[index])) invalid++;
      energy += data[index] * data[index];
      peak = Math.max(peak, Math.abs(data[index]));
      if (index && data[index - 1] <= 0 && data[index] > 0) {
        const position =
          index - 1 - data[index - 1] / (data[index] - data[index - 1]);
        first ??= position;
        last = position;
        crossings++;
      }
    }
    return {
      contextTime: context.currentTime,
      contextBeforeCapture,
      contextAfterCapture,
      measurementDurationMs: performance.now() - captureStartedAt,
      peak,
      rms: Math.sqrt(energy / data.length),
      invalid,
      spectralPeakHz: ((bin + offset) * outputRate) / analyser.fftSize,
      toneHz:
        crossings > 1 ? ((crossings - 1) * outputRate) / (last - first) : null,
    };
  }
  async function schedule(
    outputStartFrame,
    sourceStartFrame,
    silent = false,
    playbackRate = rate,
  ) {
    const clock = createRateWindow({
      outputStartFrame,
      sourceStartFrame,
      sourceSampleRate: sourceRate,
      outputSampleRate: outputRate,
      frameCount,
      rateAt: () => playbackRate,
    });
    const range = output.requiredPcmRange(clock);
    const channels = [0, 1].map(() =>
      Float32Array.from(
        { length: range.endFrame - range.startFrame },
        (_, index) => {
          if (silent) return 0;
          const time = (range.startFrame + index) / sourceRate;
          const relativeTime = time - 1;
          const phase = chirp
            ? 2400 * relativeTime + (50 / rate) * relativeTime * relativeTime
            : tone * time;
          return 0.2 * Math.sin(2 * Math.PI * phase);
        },
      ),
    );
    const scheduled = await output.schedule({
      clock,
      sampleRate: sourceRate,
      pcmStartFrame: range.startFrame,
      channels,
    });
    assert(
      channels.every((channel) => channel.length > 0),
      'Renderer detached the caller PCM lease',
    );
    return scheduled;
  }
  let deadline;
  try {
    await Promise.race([
      (async () => {
        await context.resume();
        result.initial = await output.initialize({
          sourceSampleRate: sourceRate,
        });
        const start = align(
          (context.currentTime + output.minimumLeadSeconds + 0.08) * outputRate,
        );
        result.scheduledStartFrame = start;
        let nextOutput = start;
        let nextSource = sourceRate;
        const stop = start + frameCount * 8;
        while (context.currentTime * outputRate < start + frameCount * 5) {
          assert(!result.failures.length, result.failures.join('; '));
          while (
            nextOutput < stop &&
            nextOutput < context.currentTime * outputRate + outputRate * 0.9
          ) {
            const scheduled = await schedule(nextOutput, nextSource);
            nextOutput = scheduled.outputEndFrame;
            nextSource = scheduled.sourceEndFrame;
          }
          await sleep(20);
          if (
            chirp &&
            !result.earlyMeasurement &&
            context.currentTime * outputRate >= start + frameCount * 3
          ) {
            result.earlyMeasurement = measure();
          }
        }
        result.measurement = measure();
        result.active = output.stats();
        assert(
          result.measurement.invalid === 0 && result.measurement.peak > 0.02,
          'No finite nonzero preserved signal',
        );
        if (chirp) {
          result.temporalSlope =
            (result.measurement.toneHz - result.earlyMeasurement.toneHz) /
            (result.measurement.contextTime -
              result.earlyMeasurement.contextTime);
          assert(
            result.temporalSlope >= 75 && result.temporalSlope <= 125,
            'Source-varying signal did not follow the scheduled tempo',
          );
        } else {
          assert(
            Math.abs(result.measurement.toneHz - tone) < 8,
            'Preserved tone frequency changed',
          );
        }
        assert(
          result.measurement.rms > 0.05 && result.measurement.rms < 0.3,
          'Preserved tone level outside diagnostic range',
        );
        if (rate === 1) {
          const cut = align(
            (context.currentTime + output.minimumLeadSeconds + 0.04) *
              outputRate,
          );
          const sourceCut =
            sourceRate + ((cut - start) * sourceRate) / outputRate;
          await output.truncate(cut);
          let position = sourceCut;
          let frame = cut;
          for (let index = 0; index < 3; index++) {
            const scheduled = await schedule(frame, position, false, 0.85);
            position = scheduled.sourceEndFrame;
            frame = scheduled.outputEndFrame;
          }
          await sleep((cut / outputRate - context.currentTime + 0.42) * 1000);
          result.truncate = {
            cutFrame: cut,
            sourceFrame: sourceCut,
            measurement: measure(),
          };
          assert(
            Math.abs(result.truncate.measurement.toneHz - tone) < 8,
            'Live preserved tempo change shifted the stationary tone',
          );
        }
        result.resetRequestedFrame = Math.ceil(
          context.currentTime * outputRate,
        );
        await output.reset();
        await sleep(120);
        analyser.getFloatTimeDomainData(data);
        result.resetTailPeak = Math.max(...data.subarray(-128).map(Math.abs));
        assert(
          result.resetTailPeak < 0.000001,
          'Reset leaked previous preserved output',
        );
        const restart = align(
          (context.currentTime + output.minimumLeadSeconds + 0.06) * outputRate,
        );
        result.silentRestartFrame = restart;
        await schedule(restart, sourceRate * 6, true);
        await sleep((restart / outputRate - context.currentTime + 0.2) * 1000);
        analyser.getFloatTimeDomainData(data);
        result.silentRestartTailPeak = Math.max(
          ...data.subarray(-128).map(Math.abs),
        );
        assert(
          result.silentRestartTailPeak < 0.000001,
          'Reused processor leaked an old source',
        );
        assert(!result.failures.length, result.failures.join('; '));
        const captured = await readCapture();
        const captureRows = captured.rows;
        if (captured.pcm) result.capturedPcm = captured.pcm;
        const firstSignal = captureRows.find((row) => row.first !== null);
        result.firstSignalFrame = firstSignal
          ? firstSignal.frame + firstSignal.first
          : null;
        result.startOffsetFrames = result.firstSignalFrame - start;
        result.capturedQuanta = captureRows.length;
        result.preStartPeak = Math.max(
          0,
          ...captureRows
            .filter((row) => row.frame + 128 <= start)
            .map((row) => row.peak),
        );
        const resetBoundary = align(result.resetRequestedFrame) + 128;
        result.postResetPeak = Math.max(
          0,
          ...captureRows
            .filter((row) => row.frame >= resetBoundary)
            .map((row) => row.peak),
        );
        if (result.truncate) {
          const boundaryRows = captureRows.filter(
            (row) => Math.abs(row.frame - result.truncate.cutFrame) <= 256,
          );
          result.truncate.minimumBoundaryQuantumPeak = Math.min(
            ...boundaryRows.map((row) => row.peak),
          );
          assert(
            boundaryRows.length >= 3 &&
              result.truncate.minimumBoundaryQuantumPeak > 0.001,
            'Live preserved tempo change introduced a silent render quantum',
          );
        }
        assert(
          result.preStartPeak === 0,
          'Preserved preroll escaped its output gate',
        );
        assert(
          result.startOffsetFrames >= 0 &&
            result.startOffsetFrames <=
              result.initial.outputLatencyFrames + 128,
          'Preserved output did not begin within its measured latency bound',
        );
        assert(
          result.postResetPeak < 0.000001,
          'Continuous capture found old audio after reset',
        );
        result.status = 'PASSED';
      })(),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Preserved diagnostic exceeded 10 seconds')),
          10000,
        );
      }),
    ]);
  } catch (error) {
    result.error = {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 6),
    };
  } finally {
    clearTimeout(deadline);
    if (capturePcm && !result.capturedPcm) {
      try {
        result.capturedPcm = (await readCapture()).pcm;
      } catch (error) {
        result.captureError = error.message;
      }
    }
    try {
      result.disposed = await output.dispose();
    } catch (error) {
      result.cleanupError = error.message;
      result.status = 'INCOMPLETE';
    }
    analyser.disconnect();
    capture.disconnect();
    capture.port.close();
    silence.disconnect();
    await context.close();
    result.contextClosed = context.state === 'closed';
  }
  return JSON.parse(
    JSON.stringify(result, (_, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ),
  );
};
