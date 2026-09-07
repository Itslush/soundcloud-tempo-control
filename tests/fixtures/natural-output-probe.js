window.naturalOutputProbe = async () => {
  const cases = [];
  const curves = {
    slowest: () => 0.025,
    slow: () => 0.25,
    natural: () => 0.85,
    original: () => 1,
    double: () => 2,
    fastest: () => 4,
    step: (time) => (time < 0.07 ? 0.85 : 0.025),
    ramp: (time) => 0.025 + Math.min(1, time / 0.16) * 0.225,
    smooth: (time) => {
      const x = Math.min(1, time / 0.16);
      return 0.85 - 0.825 * x * x * (3 - 2 * x);
    },
    jump: (time) => (time < 0.09 ? 0.025 : 4),
  };
  for (const sourceRate of [44100, 48000]) {
    const sourceFrames = 8192;
    const channels = Array.from({ length: 2 }, (_, channel) =>
      Float32Array.from(
        { length: sourceFrames },
        (_, frame) =>
          0.2 *
            Math.sin(
              ((frame / sourceRate) * (channel ? 720 : 960) + 0.125) *
                2 *
                Math.PI,
            ) +
          0.03 * Math.sin(frame * 1.7),
      ),
    );
    for (const outputRate of [48000, 96000]) {
      for (const [name, rateAt] of Object.entries(curves)) {
        const windows = [];
        let outputStartFrame = 128,
          sourceStartFrame = 0;
        while (sourceStartFrame < sourceFrames) {
          const clock = createRateWindow({
            outputStartFrame,
            sourceStartFrame,
            sourceSampleRate: sourceRate,
            outputSampleRate: outputRate,
            frameCount: Math.floor((outputRate * 0.5) / 128) * 128,
            rateAt,
          });
          windows.push(clock);
          outputStartFrame = clock.outputEndFrame;
          sourceStartFrame = clock.sourceEndFrame;
          if (windows.length > 20) throw new Error('Diagnostic schedule limit');
        }
        const endFrame = windows.at(-1).outputAt(sourceFrames);
        const length = Math.ceil(endFrame) + 128;
        const referenceContext = new OfflineAudioContext(2, length, outputRate);
        const referenceBuffer = referenceContext.createBuffer(
          2,
          sourceFrames,
          sourceRate,
        );
        channels.forEach((channel, index) =>
          referenceBuffer.copyToChannel(channel, index),
        );
        const referenceNode = referenceContext.createBufferSource();
        referenceNode.buffer = referenceBuffer;
        referenceNode.playbackRate.value = windows[0].intervals[0].rate;
        for (const clock of windows)
          for (const event of clock.intervals)
            referenceNode.playbackRate.setValueAtTime(
              event.rate,
              (event.outputFrame - 0.5) / outputRate,
            );
        referenceNode.connect(referenceContext.destination);
        referenceNode.start(128 / outputRate);
        const context = new OfflineAudioContext(2, length, outputRate);
        const renderer = createNaturalOutput({
          context,
          destination: context.destination,
          limits: { maxAheadSeconds: 16, maxNodes: 40 },
        });
        try {
          const schedules = windows.map((clock) =>
            renderer.schedule({
              clock,
              sampleRate: sourceRate,
              pcmStartFrame: 0,
              channels,
              totalSourceFrames: sourceFrames,
            }),
          );
          const held = renderer.stats();
          const [actual, reference] = await Promise.all([
            context.startRendering(),
            referenceContext.startRendering(),
          ]);
          let peak = 0,
            square = 0,
            invalid = 0,
            peakFrame = 0,
            firstMismatch = null;
          for (let channel = 0; channel < 2; channel++) {
            const output = actual.getChannelData(channel),
              baseline = reference.getChannelData(channel);
            for (let frame = 0; frame < length; frame++) {
              const delta = output[frame] - baseline[frame];
              if (!Number.isFinite(delta)) invalid++;
              square += delta * delta;
              if (firstMismatch === null && Math.abs(delta) > 1e-3)
                firstMismatch = {
                  frame,
                  actual: output[frame],
                  reference: baseline[frame],
                };
              if (Math.abs(delta) > peak) {
                peak = Math.abs(delta);
                peakFrame = frame;
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          const ended = renderer.stats();
          renderer.dispose();
          const disposed = renderer.stats();
          const rms = Math.sqrt(square / (length * 2));
          const cleanup =
            ended.nodes === 0 &&
            ended.bufferBytes === 0 &&
            disposed.disposed &&
            disposed.nodes === 0 &&
            disposed.bufferBytes === 0;
          const final = schedules.at(-1);
          const eof =
            final.sourceEndFrame === sourceFrames &&
            Math.abs(final.outputEndFrame - endFrame) < 1e-6;
          cases.push({
            name,
            sourceRate,
            outputRate,
            length,
            windows: windows.length,
            peak,
            rms,
            peakFrame,
            firstMismatch,
            invalid,
            held,
            ended,
            disposed,
            eof,
            passed:
              invalid === 0 && peak < 1e-3 && rms < 1e-5 && cleanup && eof,
          });
        } finally {
          renderer.dispose();
        }
      }
    }
  }
  const lifecycle = [];
  const endedWhileOpen = [];
  for (const outputRate of [48000, 96000]) {
    const openContext = new OfflineAudioContext(2, 128 * 90, outputRate);
    const ending = createNaturalOutput({
      context: openContext,
      destination: openContext.destination,
    });
    const endingClock = createRateWindow({
      outputStartFrame: 128,
      sourceStartFrame: 0,
      sourceSampleRate: outputRate,
      outputSampleRate: outputRate,
      frameCount: 128 * 6,
      rateAt: () => 0.025,
    });
    ending.schedule({
      clock: endingClock,
      sampleRate: outputRate,
      pcmStartFrame: 0,
      channels: [new Float32Array(1024), new Float32Array(1024)],
      totalSourceFrames: 1024,
    });
    const openSuspension = openContext.suspend((128 * 40) / outputRate);
    const openRendering = openContext.startRendering();
    await openSuspension;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = ending.stats();
    endedWhileOpen.push({
      outputRate,
      contextState: openContext.state,
      state,
      passed:
        openContext.state === 'suspended' &&
        !state.disposed &&
        state.generation === 0 &&
        state.nodes === 0 &&
        state.bufferBytes === 0 &&
        state.cleanupErrors === 0,
    });
    await openContext.resume();
    await openRendering;
    ending.dispose();
    for (const reset of [true, false]) {
      const context = new OfflineAudioContext(2, 128 * 90, outputRate);
      const renderer = createNaturalOutput({
        context,
        destination: context.destination,
      });
      const makeClock = (outputStartFrame, frameCount) =>
        createRateWindow({
          outputStartFrame,
          sourceStartFrame: 0,
          sourceSampleRate: outputRate,
          outputSampleRate: outputRate,
          frameCount,
          rateAt: () => 0.025,
        });
      const channels = Array.from({ length: 2 }, () =>
        new Float32Array(8192).fill(0.2),
      );
      const old = makeClock(128, 128 * 80);
      renderer.schedule({
        clock: old,
        sampleRate: outputRate,
        pcmStartFrame: 0,
        channels,
        totalSourceFrames: 8192,
      });
      const suspended = context.suspend((128 * 12) / outputRate);
      const rendering = context.startRendering();
      await suspended;
      const resetFrame = Math.round(context.currentTime * outputRate);
      const newStart = Math.ceil(resetFrame / 128) * 128 + 256;
      if (reset) renderer.reset();
      const stateAfterReset = renderer.stats();
      if (reset)
        renderer.schedule({
          clock: makeClock(newStart, 128 * 40),
          sampleRate: outputRate,
          pcmStartFrame: 0,
          channels: channels.map((channel) => new Float32Array(channel.length)),
          totalSourceFrames: 8192,
        });
      await context.resume();
      const rendered = await rendering;
      let beforePeak = 0,
        afterPeak = 0;
      for (let channel = 0; channel < 2; channel++) {
        const data = rendered.getChannelData(channel);
        for (let frame = 128; frame < resetFrame; frame++)
          beforePeak = Math.max(beforePeak, Math.abs(data[frame]));
        for (let frame = resetFrame; frame < data.length; frame++)
          afterPeak = Math.max(afterPeak, Math.abs(data[frame]));
      }
      renderer.dispose();
      const cleanup = renderer.stats();
      const passed =
        beforePeak > 0.1 &&
        (reset ? afterPeak === 0 : afterPeak > 0.1) &&
        cleanup.nodes === 0 &&
        cleanup.bufferBytes === 0 &&
        cleanup.cleanupErrors === 0;
      lifecycle.push({
        outputRate,
        reset,
        resetFrame,
        newStart,
        beforePeak,
        afterPeak,
        stateAfterReset,
        cleanup,
        passed,
      });
    }
  }
  return {
    cases,
    lifecycle,
    endedWhileOpen,
    passed:
      cases.every((item) => item.passed) &&
      lifecycle.every((item) => item.passed) &&
      endedWhileOpen.every((item) => item.passed),
  };
};
