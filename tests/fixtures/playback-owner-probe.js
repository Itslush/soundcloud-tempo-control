globalThis.playbackOwnerProbe = async ({ mode, sourceRate, outputRate }) => {
  const report = {
    mode,
    sourceRate,
    outputRate,
    status: 'INCOMPLETE',
    checks: {},
    errors: [],
  };
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const native = Object.getOwnPropertyDescriptors(HTMLMediaElement.prototype);
  const rawRead = (audio, key) => native[key].get.call(audio);
  const rawConnect = AudioNode.prototype.connect;
  const rawDisconnect = AudioNode.prototype.disconnect;
  const originalFactory = AudioContext.prototype.createMediaElementSource;
  const graph = installOwnerGraphFixture({ createPlaybackGate });
  const facadeBaseline = Object.getOwnPropertyDescriptors(
    HTMLMediaElement.prototype,
  );
  const context = new AudioContext({ sampleRate: outputRate });
  const audio = new Audio();
  audio.preload = 'auto';
  document.body.append(audio);
  const analyser = context.createAnalyser();
  analyser.fftSize = 16384;
  const rawMeter = context.createAnalyser();
  rawMeter.fftSize = 16384;
  const downstream = context.createGain();
  downstream.gain.value = 0.4;
  const silence = context.createGain();
  silence.gain.value = 0;
  analyser.connect(silence);
  rawMeter.connect(silence);
  silence.connect(context.destination);
  const settleMs = Math.ceil((1000 * analyser.fftSize) / outputRate) + 160;
  const urls = [];
  const records = [];
  const leases = [];
  const associations = new Map();
  let owner;
  let mediaSource;
  let control;
  let deadline;
  let phase = 'setup';
  const samples = new Float32Array(analyser.fftSize);

  function peak(node) {
    node.getFloatTimeDomainData(samples);
    check(samples.every(Number.isFinite), 'Nonfinite analyser samples');
    let maximum = 0;
    for (const value of samples) maximum = Math.max(maximum, Math.abs(value));
    return maximum;
  }

  function generated(silent = false) {
    const length = sourceRate * 10;
    const channels = [new Float32Array(length), new Float32Array(length)];
    if (!silent)
      for (let frame = 0; frame < sourceRate * 4; frame++) {
        const value = Math.fround(
          0.2 * Math.sin((2 * Math.PI * 960 * frame) / sourceRate),
        );
        channels[0][frame] = value;
        channels[1][frame] = value;
      }
    const url = URL.createObjectURL(
      new Blob([encodeWave(channels, sourceRate)], { type: 'audio/wav' }),
    );
    urls.push(url);
    const data = { url, channels, silent, length };
    associations.set(url, data);
    return data;
  }

  function decodedSource(data) {
    let disposed = false;
    let leased = 0;
    let reads = 0;
    return {
      async info() {
        check(!disposed, 'Disposed fixture source queried');
        return { duration: data.length / sourceRate };
      },
      async *read(start, end, { signal, allowEndOfStream } = {}) {
        check(!disposed, 'Disposed fixture source read');
        reads++;
        let frame = Math.floor(start * sourceRate);
        const stop = Math.min(data.length, Math.ceil(end * sourceRate));
        while (frame < stop) {
          if (signal?.aborted) throw signal.reason;
          const length = Math.min(1024, stop - frame);
          const channels = data.channels.map((channel) =>
            channel.slice(frame, frame + length),
          );
          let released = false;
          leased++;
          const packet = {
            timestamp: frame / sourceRate,
            sampleRate: sourceRate,
            channels,
            release() {
              if (released) return;
              released = true;
              channels.length = 0;
              leased--;
            },
          };
          try {
            yield packet;
          } finally {
            packet.release();
          }
          frame += length;
        }
        if (allowEndOfStream && frame >= data.length)
          return {
            endOfStream: true,
            sampleRate: sourceRate,
            endTimestamp: data.length / sourceRate,
          };
      },
      async dispose() {
        disposed = true;
      },
      stats: () => ({ disposed, leased, reads }),
    };
  }

  function inspect() {
    check(silence.gain.value === 0, 'Audible destination was enabled');
    check(!report.errors.length, `Owner reported: ${report.errors.join('; ')}`);
    const state = owner?.snapshot(audio);
    check(!state?.error, `Transport failed: ${state?.error?.message}`);
    for (const record of records) {
      const output = record.output.stats();
      const provider = record.provider.stats();
      check(
        output.nodes <= 16 && output.bufferBytes <= 32 * 1024 * 1024,
        'Renderer bound exceeded',
      );
      check(provider.ownedBytes <= 8 * 1024 * 1024, 'PCM cache bound exceeded');
    }
    if (state)
      check(
        state.scheduledWindows <= 4 && state.scheduledAheadSeconds <= 1.1,
        'Transport bound exceeded',
      );
    return state;
  }

  async function waitFor(predicate, message) {
    const started = performance.now();
    while (performance.now() - started < 12000) {
      const state = inspect();
      if (predicate(state)) return state;
      await sleep(20);
    }
    throw new Error(message);
  }

  async function settledGain(label) {
    await sleep(settleMs);
    inspect();
    const before = peak(records.at(-1).meter);
    const after = peak(analyser);
    const expected =
      audio.volume *
      10 ** (graph.outputLevel.value() / 20) *
      downstream.gain.value;
    check(
      before > 0.001 && after > 0.0001,
      `${label}: Missing processed signal`,
    );
    const ratio = after / before;
    check(
      Math.abs(ratio - expected) < 0.0005,
      `${label}: Logical/output/downstream gain applied incorrectly: ${ratio} versus ${expected}`,
    );
    return {
      before,
      after,
      ratio,
      expected,
      leaseGain: leases.at(-1).input.gain.value,
    };
  }

  async function run() {
    check(
      context.sampleRate === outputRate,
      'Requested output sample rate was not used',
    );
    const data = generated();
    const silentData = generated(true);
    audio.src = data.url;
    audio.volume = 0.8;
    graph.outputLevel.set(-6);
    mediaSource = context.createMediaElementSource(audio);
    mediaSource.connect(downstream);
    downstream.connect(analyser);
    rawConnect.call(mediaSource, rawMeter);
    check(graph.wasmAudio.hasGraph(audio), 'Legacy graph registration failed');
    await context.resume();
    await audio.play();
    await sleep(settleMs);
    const expectedNative = 0.2 * 0.8 * 10 ** (-6 / 20) * 0.4;
    const nativePeak = peak(analyser);
    check(
      Math.abs(nativePeak - expectedNative) < 0.0003,
      `Native gain mismatch: ${nativePeak} versus ${expectedNative}`,
    );
    report.checks.native = {
      peak: nativePeak,
      expected: expectedNative,
      rawVolume: rawRead(audio, 'volume'),
    };
    const moduleSource = await (await fetch('/worklet.js')).text();
    owner = createPlaybackOwner({
      acquireGraph(media, hooks) {
        const lease = graph.wasmAudio.acquireBuffered(media, hooks);
        leases.push(lease);
        return lease;
      },
      async resolveSource(media, { signal }) {
        check(!signal.aborted, 'Source resolution was cancelled');
        const source = associations.get(rawRead(media, 'src'));
        check(Boolean(source), 'Generated source association is missing');
        return source;
      },
      async createEngine({ context, destination, source, mode, signal }) {
        check(!signal.aborted, 'Engine construction was cancelled');
        const decoded = decodedSource(source);
        const provider = createPcmWindow({ source: decoded });
        const meter = context.createAnalyser();
        meter.fftSize = analyser.fftSize;
        meter.connect(destination);
        const output =
          mode === 'preserve'
            ? createPreserveOutput({
                context,
                destination: meter,
                moduleSource,
              })
            : createNaturalOutput({ context, destination: meter });
        records.push({ provider, output, meter, decoded });
        check(records.length <= 2, 'Unexpected extra playback engine');
        return { provider, output };
      },
      onError(error) {
        report.errors.push(error.message);
      },
    });
    phase = 'acquire';
    await owner.use(audio, { track: 'fixture/tone', mode, rate: 0.025 });
    await waitFor(
      (state) =>
        state?.state === 'playing' && state.renderedRate === Math.fround(0.025),
      'Buffered playback did not start',
    );
    check(
      owner.owns(audio) && !audio.paused && rawRead(audio, 'paused'),
      'Native media was not parked exclusively',
    );
    await sleep(settleMs);
    check(
      peak(rawMeter) < 0.000001,
      'Parked native source still produced signal',
    );
    const beforeContext = context.currentTime;
    const beforePosition = audio.currentTime;
    const beforeContextEnd = context.currentTime;
    await sleep(250);
    const afterContext = context.currentTime;
    const afterPosition = audio.currentTime;
    const afterContextEnd = context.currentTime;
    const expectedMinimum =
      (afterContext - beforeContextEnd) * Math.fround(0.025);
    const expectedMaximum =
      (afterContextEnd - beforeContext) * Math.fround(0.025);
    const progress = afterPosition - beforePosition;
    const tolerance = 1 / sourceRate + 0.000001;
    check(
      progress >= expectedMinimum - tolerance &&
        progress <= expectedMaximum + tolerance,
      'Facade did not follow the independent 0.025 clock',
    );
    report.checks.clock = {
      beforeContext,
      beforeContextEnd,
      afterContext,
      afterContextEnd,
      beforePosition,
      afterPosition,
      expectedMinimum,
      expectedMaximum,
      rawPosition: rawRead(audio, 'currentTime'),
    };
    report.checks.bufferedGain = await settledGain('Buffered gain');
    phase = 'volume';
    audio.volume = 0.4;
    check(
      Math.abs(leases.at(-1).input.gain.value - 0.4 * 10 ** (-6 / 20)) <
        0.000001,
      'Logical volume subscription did not update immediately',
    );
    report.checks.changedVolume = await settledGain('Changed logical volume');
    audio.muted = true;
    check(
      leases.at(-1).input.gain.value === 0,
      'Muted did not close buffered gain synchronously',
    );
    await sleep(settleMs);
    const mutedPeak = peak(analyser);
    check(mutedPeak < 0.000001, 'Muted buffered output was not silent');
    audio.muted = false;
    graph.outputLevel.set(-12);
    check(
      Math.abs(leases.at(-1).input.gain.value - 0.4 * 10 ** (-12 / 20)) <
        0.000001,
      'Output dB subscription did not update immediately',
    );
    report.checks.outputDb = await settledGain('Changed output dB');
    downstream.gain.value = 0.2;
    report.checks.downstream = await settledGain('Existing downstream gain');
    report.checks.muted = { synchronousGain: 0, settledPeak: mutedPeak };
    phase = 'seek';
    audio.currentTime = 6;
    await waitFor(
      (state) => state?.state === 'playing' && state.position >= 6,
      'Facade seek did not resume at its target',
    );
    await sleep(settleMs);
    const seekPeak = peak(analyser);
    check(
      seekPeak < 0.000001,
      'Previous-position output remained after settled seek into silence',
    );
    control = context.createConstantSource();
    control.offset.value = 0.125;
    control.connect(analyser);
    control.start();
    await sleep(100);
    const positiveControl = peak(analyser);
    check(
      positiveControl > 0.12,
      'Silence observer failed its contamination control',
    );
    control.stop();
    control.disconnect();
    control = null;
    await sleep(settleMs);
    check(peak(analyser) < 0.000001, 'Contamination control did not clean up');
    report.checks.seek = { peakAfterSettling: seekPeak, positiveControl };
    audio.currentTime = 1;
    await waitFor(
      (state) =>
        state?.state === 'playing' && state.position >= 1 && state.position < 2,
      'Return seek did not recover',
    );
    audio.volume = 0.8;
    graph.outputLevel.set(-6);
    downstream.gain.value = 0.4;
    await settledGain('Restored gain');
    phase = 'release';
    const released = await owner.release(audio);
    const nativeReleasePosition = rawRead(audio, 'currentTime');
    report.checks.release = {
      ...released,
      nativePosition: nativeReleasePosition,
      difference: nativeReleasePosition - released.position,
      contextTime: context.currentTime,
    };
    check(!owner.owns(audio), 'Owner remained active after release');
    check(rawRead(audio, 'paused'), 'Release auto-played native media');
    check(
      Math.abs(nativeReleasePosition - released.position) < 0.00001,
      'Native release position was not restored',
    );
    check(
      leases.at(-1).input.gain.value === 0,
      'Released buffered gain remained open',
    );
    await sleep(settleMs);
    check(peak(analyser) < 0.000001, 'Released paused output was not silent');
    await audio.play();
    await sleep(settleMs);
    const resumedNativePeak = peak(analyser);
    check(
      Math.abs(resumedNativePeak - expectedNative) < 0.0003,
      'Native route or downstream gain was lost on handback',
    );
    report.checks.release = {
      ...report.checks.release,
      peakAfterNativePlay: resumedNativePeak,
      expected: expectedNative,
    };
    phase = 'source-change';
    await owner.use(audio, { track: 'fixture/tone', mode, rate: 0.025 });
    await waitFor(
      (state) => state?.state === 'playing',
      'Second ownership did not start',
    );
    await settledGain('Second ownership');
    const oldPosition = audio.currentTime;
    audio.src = silentData.url;
    check(
      !owner.owns(audio),
      'Source replacement did not detach synchronously',
    );
    check(
      leases.at(-1).input.gain.value === 0,
      'Source replacement left buffered gain open',
    );
    await waitFor(
      () => rawRead(audio, 'readyState') >= 2,
      'Replacement native media did not load',
    );
    check(
      rawRead(audio, 'currentTime') < 0.01,
      'Old source position was restored into replacement media',
    );
    await audio.play();
    await waitFor(
      () => rawRead(audio, 'currentTime') >= 0.2,
      'Replacement native media did not advance',
    );
    await sleep(settleMs);
    const replacementPeak = peak(analyser);
    check(
      replacementPeak < 0.000001,
      'Previous-source output remained after settled replacement',
    );
    report.checks.sourceChange = {
      oldPosition,
      newPosition: rawRead(audio, 'currentTime'),
      peakAfterSettling: replacementPeak,
    };
    report.status = 'PASSED';
  }

  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Owner integration exceeded 60 seconds')),
          60000,
        );
      }),
    ]);
  } catch (error) {
    report.error = {
      phase,
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8),
    };
    report.state = owner?.snapshot(audio);
  } finally {
    clearTimeout(deadline);
    const errors = [];
    try {
      if (control) {
        control.stop();
        control.disconnect();
      }
    } catch (error) {
      errors.push(error.message);
    }
    try {
      await owner?.dispose();
    } catch (error) {
      errors.push(error.message);
    }
    native.pause.value.call(audio);
    const prototypeRestored = [
      'currentTime',
      'duration',
      'paused',
      'ended',
      'seeking',
      'readyState',
      'networkState',
      'play',
      'pause',
      'load',
      'src',
      'srcObject',
      'fastSeek',
    ].every((key) => {
      const current = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        key,
      );
      const before = facadeBaseline[key];
      return (
        current?.get === before?.get &&
        current?.set === before?.set &&
        current?.value === before?.value
      );
    });
    const engines = records.map((record) => ({
      output: record.output.stats(),
      provider: record.provider.stats(),
      source: record.decoded.stats(),
    }));
    for (const record of records) record.meter.disconnect();
    mediaSource?.disconnect();
    if (mediaSource) rawDisconnect.call(mediaSource);
    downstream.disconnect();
    analyser.disconnect();
    rawMeter.disconnect();
    silence.disconnect();
    await context.close();
    await sleep(20);
    audio.removeAttribute('src');
    native.load.value.call(audio);
    audio.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    report.cleanup = {
      errors,
      engines,
      prototypeRestored,
      ownerActive: owner?.owns(audio) ?? false,
      graphActive: graph.wasmAudio.hasGraph(audio),
      contextClosed: context.state === 'closed',
      zeroDestination: silence.gain.value === 0,
      leasedGains: leases.map((lease) => lease.input.gain.value),
    };
    report.cleanupPassed =
      !errors.length &&
      prototypeRestored &&
      !report.cleanup.ownerActive &&
      !report.cleanup.graphActive &&
      report.cleanup.contextClosed &&
      report.cleanup.zeroDestination &&
      engines.every(
        ({ output, provider, source }) =>
          output.nodes === 0 &&
          output.bufferBytes === 0 &&
          provider.ownedBytes === 0 &&
          provider.activeJobs === 0 &&
          provider.activeLeases === 0 &&
          source.disposed &&
          source.leased === 0,
      ) &&
      report.cleanup.leasedGains.every((gain) => gain === 0);
    if (!report.cleanupPassed) report.status = 'INCOMPLETE';
    AudioContext.prototype.createMediaElementSource = originalFactory;
    AudioNode.prototype.connect = rawConnect;
    AudioNode.prototype.disconnect = rawDisconnect;
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', native.volume);
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', native.muted);
  }
  return JSON.parse(
    JSON.stringify(report, (_, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ),
  );
};
