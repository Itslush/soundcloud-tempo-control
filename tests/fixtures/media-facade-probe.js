globalThis.mediaFacadeProbe = async () => {
  const report = { passed: false, assertions: [] };
  const check = (value, message) => {
    if (!value) throw new Error(message);
    report.assertions.push(message);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate) => {
    const end = performance.now() + 4000;
    while (performance.now() < end) {
      if (predicate()) return;
      await sleep(10);
    }
    throw new Error('Timed out waiting for media transition');
  };
  const prototype = HTMLMediaElement.prototype;
  const time = Object.getOwnPropertyDescriptor(prototype, 'currentTime');
  const paused = Object.getOwnPropertyDescriptor(prototype, 'paused');
  const originalPlay = prototype.play;
  const context = new AudioContext({ sampleRate: 48000 });
  const silence = context.createGain();
  silence.gain.value = 0;
  silence.connect(context.destination);
  const audio = new Audio();
  audio.volume = 0.42;
  const events = [];
  let sourceDisposed = false;
  const source = {
    async info() {
      return { duration: 12 };
    },
    async *read(start, end, { signal } = {}) {
      let frame = Math.floor(start * 48000);
      const stop = Math.min(576000, Math.ceil(end * 48000));
      while (frame < stop) {
        if (signal?.aborted) throw signal.reason;
        const length = Math.min(1024, stop - frame);
        const channels = Array.from({ length: 2 }, () =>
          Float32Array.from(
            { length },
            (_, index) =>
              0.125 * Math.sin(((frame + index) * 2 * Math.PI * 440) / 48000),
          ),
        );
        const packet = {
          sampleRate: 48000,
          timestamp: frame / 48000,
          channels,
          release() {
            channels.length = 0;
          },
        };
        try {
          yield packet;
        } finally {
          packet.release();
        }
        frame += length;
      }
      if (frame >= 576000)
        return { endOfStream: true, sampleRate: 48000, endTimestamp: 12 };
    },
    dispose() {
      sourceDisposed = true;
    },
  };
  const provider = createPcmWindow({ source });
  const output = createNaturalOutput({ context, destination: silence });
  let binding;
  const transport = createBufferedTransport({
    context,
    provider,
    output,
    rate: 0.025,
    onChange: (state) => binding?.update(state),
  });
  const errors = [];
  const facade = createMediaFacade({
    onError: (error) => errors.push(error.message),
  });
  binding = facade.bind(audio, { transport });
  for (const name of [
    'play',
    'playing',
    'pause',
    'waiting',
    'seeking',
    'seeked',
    'ended',
  ])
    audio.addEventListener(name, () => events.push(name));
  try {
    const pending = audio.play();
    audio.pause();
    const result = await Promise.allSettled([pending]);
    check(
      result[0].status === 'rejected' && result[0].reason.name === 'AbortError',
      'Cold Play is cancelled by Pause',
    );
    await audio.play();
    check(events.includes('playing'), 'Play resolves after the playing event');
    check(
      !audio.paused && paused.get.call(audio),
      'Buffered playing state does not start native media',
    );
    const before = { media: audio.currentTime, context: context.currentTime };
    await sleep(200);
    const advanced = audio.currentTime - before.media;
    const expected =
      (context.currentTime - before.context) * Math.fround(0.025);
    check(
      Math.abs(advanced - expected) < 0.0001,
      'HTML currentTime follows the rendered 0.025x clock',
    );
    check(time.get.call(audio) === 0, 'Native media clock remains parked');
    audio.currentTime = 6;
    check(
      audio.seeking && audio.currentTime >= 6,
      'Seek immediately exposes the requested source position',
    );
    await until(() => !audio.seeking && events.includes('seeked'));
    await until(() => transport.snapshot().state === 'playing');
    check(
      audio.currentTime >= 6 && audio.currentTime < 6.1,
      'Seek resumes from the new PCM position',
    );
    audio.pause();
    const stopped = audio.currentTime;
    await sleep(100);
    check(
      audio.currentTime === stopped && output.stats().nodes === 0,
      'Pause freezes clock and removes scheduled output',
    );
    check(audio.volume === 0.42, 'Playback commands preserve logical volume');
    const other = new Audio();
    other.currentTime = 3;
    check(
      other.currentTime === 3 && other.paused,
      'Unowned media retains native state',
    );
    audio.load();
    await until(() => sourceDisposed);
    check(
      !facade.owns(audio) && !binding.active,
      'Native load releases buffered ownership',
    );
    check(
      output.stats().nodes === 0 && provider.stats().ownedBytes === 0,
      'Source handoff releases PCM and output nodes',
    );
    await facade.dispose();
    check(
      prototype.play === originalPlay &&
        Object.getOwnPropertyDescriptor(prototype, 'currentTime').get ===
          time.get,
      'Facade disposal restores native descriptors',
    );
    check(errors.length === 0, 'No asynchronous facade errors');
    report.events = events;
    report.clock = { advanced, expected };
    report.passed = true;
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    await facade.dispose();
    await transport.dispose();
    silence.disconnect();
    await context.close();
    report.cleanup = {
      sourceDisposed,
      provider: provider.stats(),
      output: output.stats(),
      contextClosed: context.state === 'closed',
    };
  }
  return report;
};
