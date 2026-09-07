globalThis.bufferedTransportProbe = async ({ live, preserve = false, sourceSampleRate = 48000, outputSampleRate = 48000 }) => {
  const report = { status: 'INCOMPLETE', live, preserve, sourceSampleRate, outputSampleRate, cases: [] };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const context = new AudioContext({ sampleRate: outputSampleRate });
  const analyser = context.createAnalyser();
  analyser.fftSize = preserve ? 16384 : 2048;
  const settleMs = Math.ceil(1000 * analyser.fftSize / context.sampleRate) + 60;
  const silence = context.createGain();
  silence.gain.value = 0;
  analyser.connect(silence);
  silence.connect(context.destination);
  let source;
  let provider;
  let output;
  let transport;
  let deadline;
  let maxNodes = 0;
  let maxBuffers = 0;
  let maxWindows = 0;
  let maxAhead = 0;
  let contamination = null;
  let capture = null;
  const signal = new Float32Array(analyser.fftSize);

  function generatedSource() {
    const sampleRate = sourceSampleRate;
    const totalFrames = sampleRate * 12;
    let disposed = false;
    let reads = 0;
    let released = 0;
    let leased = 0;
    return {
      async info() {
        return { duration: 12 };
      },
      async *read(start, end, { signal, allowEndOfStream } = {}) {
        check(!disposed, 'Generated source used after disposal');
        reads++;
        let frame = Math.floor(start * sampleRate);
        const stop = Math.min(totalFrames, Math.ceil(end * sampleRate));
        while (frame < stop) {
          if (signal?.aborted) throw signal.reason;
          const length = Math.min(1024, stop - frame);
          const channels = [new Float32Array(length), new Float32Array(length)];
          for (let channel = 0; channel < 2; channel++)
            for (let index = 0; index < length; index++)
              channels[channel][index] =
                frame + index < sampleRate * (preserve ? 5 : 3)
                  ? preserve ? 0.15 * Math.sin(2 * Math.PI * 960 * (frame + index) / sampleRate) : 0.125
                  : 0;
          let done = false;
          leased++;
          const packet = {
            timestamp: frame / sampleRate,
            sampleRate,
            channels,
            release() {
              if (done) return;
              done = true;
              channels.length = 0;
              leased--;
              released++;
            },
          };
          try {
            yield packet;
          } finally {
            packet.release();
          }
          frame += length;
        }
        if (allowEndOfStream && frame >= totalFrames)
          return { endOfStream: true, sampleRate, endTimestamp: 12 };
      },
      async dispose() {
        disposed = true;
      },
      stats: () => ({ disposed, reads, released, leased }),
    };
  }

  function state() {
    const before = context.currentTime;
    const value = transport.snapshot();
    const after = context.currentTime;
    check(!value.error, `Transport error: ${value.error?.message}`);
    const stats = output.stats();
    maxNodes = Math.max(maxNodes, stats.nodes);
    maxBuffers = Math.max(maxBuffers, stats.bufferBytes);
    maxWindows = Math.max(maxWindows, value.scheduledWindows);
    maxAhead = Math.max(maxAhead, value.scheduledAheadSeconds);
    check(
      stats.nodes <= 16 && stats.bufferBytes <= 32 * 1024 * 1024,
      'Output budget exceeded',
    );
    check(
      value.scheduledWindows <= 4 && value.scheduledAheadSeconds <= 1.1,
      'Transport scheduling exceeded its bound',
    );
    check(
      provider.stats().ownedBytes <= 8 * 1024 * 1024,
      'PCM cache budget exceeded',
    );
    const sourceState = source.stats();
    if (live)
      check(
        sourceState.peakHeldEncodedBytes <= 16 * 1024 * 1024 &&
          sourceState.peakHeldPcmBytes <= 2 * 1024 * 1024 &&
          sourceState.peakDecodeQueueSize <= 2,
        'Decoded-source resource budget exceeded',
      );
    return { before, after, ...value };
  }

  function amplitude() {
    analyser.getFloatTimeDomainData(signal);
    check(
      signal.every(Number.isFinite),
      'Rendered output contains non-finite samples',
    );
    return Math.max(...signal.map(Math.abs));
  }

  function frequency() {
    analyser.getFloatTimeDomainData(signal);
    const crossings = [];
    for (let index = 1; index < signal.length; index++) {
      if (signal[index - 1] > 0 || signal[index] <= 0) continue;
      crossings.push(index - 1 - signal[index - 1] / (signal[index] - signal[index - 1]));
    }
    return crossings.length > 1
      ? (crossings.length - 1) * context.sampleRate / (crossings.at(-1) - crossings[0])
      : null;
  }

  async function waitFor(predicate, message, limit = 12000) {
    const start = performance.now();
    while (performance.now() - start < limit) {
      const value = state();
      if (predicate(value)) return value;
      await sleep(20);
    }
    throw new Error(message);
  }

  async function measureRate(rate) {
    await waitFor(
      (value) =>
        value.state === 'playing' && value.scheduledAheadSeconds > 0.45 && value.renderedRate === Math.fround(rate),
      'Playback did not stabilize',
    );
    await sleep(100);
    const first = state();
    let peak = amplitude();
    const points = [];
    for (let index = 0; index < 5; index++) {
      await sleep(60);
      const current = state();
      check(
        current.state === 'playing',
        'Unexpected buffer underrun during clock measurement',
      );
      peak = Math.max(peak, amplitude());
      const actual = current.position - first.position;
      const expectedMinimum =
        Math.fround(rate) * (current.before - first.after);
      const expectedMaximum =
        Math.fround(rate) * (current.after - first.before);
      const tolerance = 1 / current.sampleRate + 0.000001;
      check(
        actual >= expectedMinimum - tolerance &&
          actual <= expectedMaximum + tolerance,
        `Rate ${rate} position mismatch: ${actual} outside ${expectedMinimum}..${expectedMaximum}`,
      );
      points.push({
        contextTime: current.after,
        position: current.position,
        actual,
        expectedMinimum,
        expectedMaximum,
      });
    }
    check(peak > 0.000001, `No nonzero decoded output at ${rate}`);
    const toneHz = preserve && !live ? frequency() : null;
    if (preserve && !live) {
      report.pitchWindows ??= [];
      report.pitchWindows.push({
        rate,
        toneHz,
        contextTime: context.currentTime,
        transport: state(),
        samples: Array.from(signal),
      });
      if (capture) {
        const generation = output.stats().generation;
        const first = report.schedules.find((item) => item.generation === generation);
        check(Boolean(first), 'No schedule for aligned capture');
        const start = first.outputStartFrame + Math.ceil(context.sampleRate * 0.08 / 128) * 128;
        const length = 16384;
        await waitFor(() => context.currentTime * context.sampleRate >= start + length + 256,
          'Aligned capture did not complete');
        const captured = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Frame capture timed out')), 3000);
          capture.port.onmessage = ({ data }) => {
            clearTimeout(timer);
            if (data.error) reject(new Error(data.error));
            else resolve(data);
          };
          capture.port.postMessage({ id: report.pitchWindows.length, start, length });
        });
        report.pitchWindows.at(-1).aligned = {
          startFrame: start,
          offsetFrames: start - first.outputStartFrame,
          sourceStartFrame: first.sourceStartFrame,
          generation,
          samples: Array.from(captured.samples),
        };
      }
    }
    if (preserve && !live) check(toneHz !== null && Math.abs(toneHz - 960) < 8, `Preserved tone changed pitch: ${toneHz}`);
    return {
      rate,
      first,
      points,
      peak,
      toneHz,
      provider: provider.stats(),
      output: output.stats(),
    };
  }

  async function run() {
    await context.resume();
    if (preserve && !live) {
      await context.audioWorklet.addModule('/frame-capture-worklet.js');
      capture = new AudioWorkletNode(context, 'tempo-frame-capture');
      analyser.connect(capture);
      capture.connect(silence);
    }
    if (live) {
      check(typeof Mediabunny === 'object', 'Diagnostic decoder is missing');
      const stopped = streamSourceProbe.stop();
      check(
        stopped.media.every((audio) => audio.paused),
        'Native player must be paused',
      );
      const urls = [
        ...new Set(
          performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((url) => /\.m3u8(?:\?|$)/.test(url)),
        ),
      ];
      check(urls.length > 0, 'No observed public playlist');
      report.sourceHost = new URL(urls[0]).hostname;
      source = createPcmSource({ library: Mediabunny, url: urls[0] });
    } else source = generatedSource();
    provider = createPcmWindow({ source });
    output = preserve
      ? createPreserveOutput({ context, destination: analyser, moduleSource: await (await fetch('/worklet.js')).text() })
      : createNaturalOutput({ context, destination: analyser });
    if (preserve) {
      const renderer = output;
      report.schedules = [];
      const schedule = async (input) => {
        const submittedAt = context.currentTime;
        const result = await renderer.schedule(input);
        check(report.schedules.length < 400, 'Diagnostic schedule history exceeded its bound');
        report.schedules.push({ generation: renderer.stats().generation, submittedAt, acknowledgedAt: context.currentTime, ...result });
        return result;
      };
      output = Object.create(renderer, { schedule: { value: schedule } });
    }
    transport = createBufferedTransport({
      context,
      provider,
      output,
      rate: 0.025,
    });
    const coldPlay = transport.play();
    const coldPause = transport.pause();
    const coldResult = await Promise.allSettled([coldPlay]);
    check(
      state().state === 'paused' && (preserve ? output.stats().windows === 0 : output.stats().nodes === 0),
      'Cancelled initialization scheduled output',
    );
    report.coldCancellation = {
      pause: coldPause,
      result: coldResult[0].status,
      reason: coldResult[0].reason?.name,
    };
    for (const rate of [0.025, 0.85, 4]) {
      if (rate !== 0.025) transport.pause();
      await transport.seek(live ? 10 : 0);
      await transport.setRate(rate);
      await transport.play();
      report.cases.push(await measureRate(rate));
    }
    const beforePause = state();
    const paused = transport.pause();
    await sleep(Math.max(140, settleMs));
    const afterPause = state();
    check(
      afterPause.position === paused.position && afterPause.state === 'paused',
      'Pause did not freeze source position',
    );
    check(
      (preserve ? output.stats().windows === 0 : output.stats().nodes === 0) && output.stats().bufferBytes === 0,
      'Pause retained scheduled output or PCM',
    );
    check(amplitude() < 0.000001, 'Paused output was not silent');
    await transport.play();
    const resumed = await waitFor(
      (value) => value.state === 'playing' && value.position > paused.position,
      'Resume did not advance',
    );
    report.pauseResume = { beforePause, paused, afterPause, resumed };
    await transport.setRate(0.85);
    report.liveRateChange = await measureRate(0.85);
    const beforeSeek = state();
    const supersededSeek = transport.seek(live ? 20 : 4);
    await sleep(5);
    const finalSeek = transport.seek(live ? 60 : 6);
    const seekResults = await Promise.allSettled([supersededSeek, finalSeek]);
    const afterSeek = await waitFor(
      (value) => value.state === 'playing',
      'Seek did not resume',
    );
    check(
      afterSeek.generation >= beforeSeek.generation + 2,
      'Seek reused the old transport generation',
    );
    check(
      afterSeek.position >= (live ? 60 : 6) &&
        afterSeek.position < (live ? 61 : 7),
      'Seek position was not anchored to the target',
    );
    await sleep(Math.max(160, settleMs));
    const seekPeak = amplitude();
    if (!live)
      check(
        seekPeak < 0.000001,
        'Old generated audio leaked after seeking to silence',
      );
    report.seek = {
      beforeSeek,
      afterSeek,
      supersededSeek: seekResults.map((result) => ({
        status: result.status,
        reason: result.reason?.name,
      })),
      peakAfterSettling: seekPeak,
      signalLeakCheck: live
        ? 'Clock/generation only'
        : 'Constant old signal to silent target',
    };
    if (!live) {
      contamination = context.createBufferSource();
      contamination.buffer = context.createBuffer(2, 1024, context.sampleRate);
      contamination.buffer.getChannelData(0).fill(0.125);
      contamination.buffer.getChannelData(1).fill(0.125);
      contamination.loop = true;
      contamination.connect(analyser);
      contamination.start();
      await sleep(100);
      report.seek.signalObserverControl = amplitude();
      check(
        report.seek.signalObserverControl > 0.1,
        'Silence observer failed to detect deliberately injected old signal',
      );
      contamination.stop();
      contamination.disconnect();
      contamination.buffer = null;
      contamination = null;
      await sleep(Math.max(100, settleMs));
      check(amplitude() < 0.000001, 'Signal observer control did not clean up');
    }
    const hint = state().durationHint;
    check(
      Number.isFinite(hint) && hint > 0.3,
      'End probe needs a finite seek hint',
    );
    report.endRateChange = await transport.setRate(4);
    check(!report.endRateChange.error, `End rate change failed: ${report.endRateChange.error?.message}`);
    await transport.seek(hint - 0.3);
    const end = await waitFor(
      (value) => value.state === 'ended',
      'Verified decoded EOF did not end playback',
    );
    check(
      end.position === end.duration &&
        end.sourceFrame === provider.stats().totalSourceFrames &&
        (!live ? end.position === 12 : Math.abs(end.position - hint) < 1),
      'Verified EOF position was wrong',
    );
    await sleep(80);
    check(preserve ? output.stats().windows === 0 : output.stats().nodes === 0, 'EOF retained scheduled output');
    report.eof = end;
    report.bounds = {
      maxNodes,
      maxBuffers,
      maxWindows,
      maxAhead,
      provider: provider.stats(),
      source: source.stats(),
    };
    report.status = 'PASSED';
  }

  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(new Error('Buffered transport probe exceeded 60 seconds')),
          60000,
        );
      }),
    ]);
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8),
    };
    report.transport = transport?.snapshot();
  } finally {
    clearTimeout(deadline);
    const errors = [];
    if (contamination) {
      contamination.stop();
      contamination.disconnect();
      contamination.buffer = null;
    }
    try {
      await transport?.dispose();
    } catch (error) {
      errors.push(error.message);
    }
    report.cleanup = {
      transport: transport?.snapshot(),
      output: output?.stats(),
      provider: provider?.stats(),
      source: source?.stats(),
      errors,
    };
    analyser.disconnect();
    capture?.disconnect();
    capture?.port.close();
    silence.disconnect();
    await context.close();
    report.audioContextClosed = context.state === 'closed';
    const clean =
      !errors.length &&
      report.cleanup.output?.nodes === 0 &&
      report.cleanup.output?.bufferBytes === 0 &&
      (report.cleanup.output?.cleanupErrors ?? 0) === 0 &&
      report.cleanup.provider?.ownedBytes === 0 &&
      report.cleanup.provider?.activeJobs === 0 &&
      report.cleanup.provider?.activeLeases === 0 &&
      report.cleanup.source?.disposed &&
      (live
        ? report.cleanup.source.heldEncodedBytes === 0 &&
          report.cleanup.source.heldPcmBytes === 0 &&
          report.cleanup.source.activeTransactions === 0 &&
          report.cleanup.source.openedDecoders ===
            report.cleanup.source.closedDecoders &&
          report.cleanup.source.receivedSamples ===
            report.cleanup.source.closedSamples
        : report.cleanup.source.leased === 0);
    report.cleanupPassed = clean;
    if (!clean) report.status = 'INCOMPLETE';
  }
  return JSON.parse(
    JSON.stringify(report, (_, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ),
  );
};
