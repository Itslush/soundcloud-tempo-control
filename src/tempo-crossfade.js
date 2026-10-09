export function createCrossfade({
  modules,
  graph,
  sourceFor,
  resolveSource = sourceFor,
  sourceStats = () => null,
  preloadNext,
  readNextRate = () => 4,
  readNextSettings,
  readSettings,
  readTrack,
  nextButton,
  onState,
  storage = localStorage,
  timers = globalThis,
}) {
  const enabledKey = 'soundcloud.tempo.crossfade';
  const secondsKey = 'soundcloud.tempo.crossfadeSeconds';
  let enabled = false;
  let seconds = 5;
  let selected;
  let job;
  let timer;
  let message = '';
  let disposed = false;
  const history = [];
  const nextSettingsFor = (url) =>
    readNextSettings
      ? readNextSettings(url)
      : {
          ...readSettings(selected),
          rate: readNextRate(url),
        };
  const clean = (value) =>
    String(value)
      .replace(/https?:\/\/\S+/g, '[URL omitted]')
      .slice(0, 300);

  function status(value) {
    value = clean(value);
    if (message === value) return;
    message = value;
    history.push({ at: new Date().toISOString(), message });
    if (history.length > 12) history.shift();
    onState?.();
  }

  function cancel(reason) {
    const previous = job;
    job = null;
    previous?.controller.abort();
    try {
      previous?.next?.dispose();
    } finally {
      previous?.route?.dispose();
    }
    if (previous && reason) status(`Crossfade cancelled: ${reason}.`);
  }

  function signature(audio) {
    const settings = readSettings(audio);
    return JSON.stringify([
      readTrack(),
      audio.currentSrc,
      audio.duration,
      settings.rate,
      settings.preserve,
      settings.shift,
      settings.variable,
    ]);
  }

  async function decode(current, url, start, length = Infinity) {
    const { signal } = current.controller;
    const { Mediabunny } = await modules.loadAudioDependencies({ signal });
    const provider = modules.createPcmWindow({
      source: modules.createPcmSource({ library: Mediabunny, url }),
    });
    try {
      const info = await provider.info({ signal });
      const duration =
        info.totalSourceFrames === undefined
          ? info.durationHint
          : info.totalSourceFrames / info.sampleRate;
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error('This stream’s duration is unavailable.');
      const first = Math.floor(start * info.sampleRate);
      const end = Math.floor(
        Math.min(duration, start + length) * info.sampleRate,
      );
      const frames = end - first;
      if (frames <= 0 || frames * 8 > 32 * 1024 * 1024)
        throw new Error('This track’s crossfade buffer is too large.');
      const buffer = graph
        .contextFor(current.audio)
        .createBuffer(2, frames, info.sampleRate);
      for (let from = first; from < end; from += info.sampleRate) {
        const to = Math.min(end, from + info.sampleRate);
        const lease = await provider.acquire(from, to, { signal });
        try {
          if (
            lease.channels.length !== 2 ||
            lease.channels.some((channel) => channel.length !== to - from)
          )
            throw new Error('The crossfade audio buffer is incomplete.');
          for (let channel = 0; channel < 2; channel++)
            buffer.copyToChannel(
              lease.channels[channel],
              channel,
              from - first,
            );
        } finally {
          lease.release();
        }
      }
      return { buffer, duration, start: first / info.sampleRate };
    } finally {
      await provider.dispose();
    }
  }

  async function prepareOpening(current) {
    current.decodingOpening = true;
    status('Preparing the next track’s opening…');
    try {
      const settings = nextSettingsFor(current.next.trackUrl);
      if (settings.variable)
        throw new Error('The next track uses a tempo timeline.');
      const url = current.next.streamUrl();
      const decoded = await decode(
        current,
        url,
        0,
        (seconds + 8) * settings.rate,
      );
      if (decoded.duration / settings.rate < seconds + 2)
        throw new Error('The next track is too short for this crossfade.');
      const opening = await graph.prepareIncoming(
        current.audio,
        decoded.buffer,
        settings,
        current.controller,
      );
      if (job !== current || current.controller.signal.aborted) return;
      if (!current.next.matches() || current.next.streamUrl() !== url)
        throw new Error('The next stream changed during preparation.');
      current.opening = opening;
      current.openingUrl = url;
      current.nextSettings = settings;
      status('Crossfade ready.');
    } catch (error) {
      if (job === current && !current.controller.signal.aborted) {
        current.failed = true;
        current.buffer = null;
        current.next?.dispose();
        current.next = null;
        status(`Playing normally. ${error.message}`);
      }
    } finally {
      current.decodingOpening = false;
    }
  }

  async function prepare(current) {
    try {
      const { signal } = current.controller;
      current.waitingNext = true;
      current.next = await preloadNext(current.audio, { signal });
      current.waitingNext = false;
      if (job !== current || signal.aborted) {
        current.next.dispose();
        return;
      }
      current.waitingSource = true;
      status('Identifying the current track’s audio…');
      const source = await resolveSource(current.audio, { signal });
      if (job !== current || signal.aborted) return;
      current.waitingSource = false;
      if (source.status !== 'bound')
        throw new Error('This track’s audio could not be identified.');
      current.sourceId = source.sourceId;
      current.generation = source.generation;
      const { buffer, duration, start } = await decode(
        current,
        source.playlistUrl,
        current.start,
      );
      if (
        !Number.isFinite(duration) ||
        Math.abs(duration - current.audio.duration) > 0.25
      )
        throw new Error('This stream’s timing is not suitable for crossfade.');
      if (job !== current || signal.aborted) return;
      const latest = await resolveSource(current.audio, { signal });
      if (job !== current || signal.aborted) return;
      if (
        signature(current.audio) !== current.signature ||
        latest.status !== 'bound' ||
        latest.sourceId !== current.sourceId ||
        latest.generation !== current.generation
      )
        throw new Error('The track changed while preparing crossfade.');
      current.start = start;
      current.buffer = buffer;
      status('Buffering the next track…');
    } catch (error) {
      if (job === current && error.name !== 'AbortError') {
        const waitingSource = current.waitingSource;
        current.failed = true;
        if (error.code === 'SOUNDCLOUD_QUEUE_PENDING')
          current.retryPosition =
            current.audio.currentTime + 2 * readSettings(current.audio).rate;
        current.waitingNext = false;
        current.waitingSource = false;
        current.next?.dispose();
        current.next = null;
        status(
          `Playing normally. ${
            waitingSource
              ? 'This track’s audio could not be identified. See crossfade diagnostics.'
              : error.message
          }`,
        );
      }
    }
  }

  function tick() {
    const audio = selected;
    if (!enabled || disposed || !audio) return;
    if (job?.route) {
      const current = job;
      const remaining =
        current.route.endTime - current.route.context.currentTime;
      if (remaining <= 0 || current.route.context.state !== 'running') {
        cancel();
        status(
          current.fading
            ? 'Crossfade complete.'
            : 'The buffered opening ended before SoundCloud could synchronize; native playback restored.',
        );
        return;
      }
      const track = readTrack();
      if (track && track !== current.track) {
        if (current.incomingTrack && current.incomingTrack !== track) {
          cancel();
          return;
        }
        current.incomingTrack = track;
      }
      current.route.silence(audio);
      const changed =
        audio !== current.audio || audio.currentTime < current.position - 0.5;
      if (
        !current.fading &&
        current.incomingTrack &&
        changed &&
        !audio.paused &&
        !audio.seeking &&
        audio.readyState >= 2 &&
        graph.crossfadeReady(audio, readSettings(audio))
      ) {
        if (!current.next.isCurrent(audio)) {
          cancel();
          status('The queued track changed; playing normally.');
          return;
        }
        const actual = readSettings(audio);
        const expected = current.nextSettings;
        if (
          actual.variable ||
          actual.rate !== expected.rate ||
          actual.preserve !== expected.preserve ||
          actual.shift !== expected.shift
        ) {
          cancel('incoming tempo or pitch changed');
          return;
        }
        const now = current.route.context.currentTime;
        const desired = current.route.position() * expected.rate;
        const audible = current.route.nativePosition(audio);
        current.handoffError = audible - desired;
        if (Math.abs(current.handoffError) > 0.02 * expected.rate) {
          if (now >= (current.seekAfter ?? 0)) {
            // Seek only the verified native next track, while its output is masked by the opening buffer.
            audio.currentTime =
              desired + Math.max(0, audio.currentTime - audible);
            current.seekAfter = now + 0.75;
            status('Crossfading; synchronizing SoundCloud underneath…');
          }
        } else if (now >= current.route.overlapEnd) {
          current.fading = current.route.fadeIn(audio);
          if (current.fading)
            status('Returning to synchronized native playback…');
        }
      }
      return;
    }
    if (audio.paused || audio.seeking || !Number.isFinite(audio.duration))
      return;
    const settings = readSettings(audio);
    const currentSignature = signature(audio);
    if (job && job.signature !== currentSignature)
      cancel('track or tempo changed');
    if (job?.next && !job.next.matches()) cancel('queue changed');
    if (job?.failed && audio.currentTime >= job.retryPosition) cancel();
    const remaining = (audio.duration - audio.currentTime) / settings.rate;
    if (settings.variable) {
      status('Crossfade waits until the tempo timeline is steady.');
      return;
    }
    if (!graph.crossfadeReady(audio, settings)) {
      status('Crossfade needs a ready player audio connection.');
      return;
    }
    if (audio.duration / settings.rate < seconds * 2 + 2 || remaining < 0.5) {
      status('Playing normally. Not enough track time for crossfade.');
      return;
    }
    if (!job && remaining > Math.max(60, seconds + 30)) {
      status('Crossfade enabled. Preloading starts near the end of the track.');
      return;
    }
    if (!job && remaining <= Math.max(60, seconds + 30)) {
      job = {
        audio,
        track: readTrack(),
        signature: currentSignature,
        start: Math.max(0, audio.duration - (seconds + 2) * settings.rate),
        controller: new AbortController(),
      };
      status('Preloading the next track…');
      void prepare(job);
    }
    if (!job?.buffer) return;
    const nextRate = readNextRate(job.next.trackUrl);
    job.requiredSeconds =
      (seconds + 1) *
      (Number.isFinite(nextRate) && nextRate >= 0.25 && nextRate <= 4
        ? nextRate
        : 4);
    job.nextReady = job.next.ready(job.requiredSeconds);
    if (!job.nextReady) {
      status('Buffering the next track; playback continues normally.');
      return;
    }
    if (!job.opening) {
      if (!job.decodingOpening) void prepareOpening(job);
      return;
    }
    if (
      JSON.stringify(nextSettingsFor(job.next.trackUrl)) !==
        JSON.stringify(job.nextSettings) ||
      job.next.streamUrl() !== job.openingUrl
    ) {
      cancel('next track settings changed');
      return;
    }
    status('Crossfade ready.');
    if (remaining > seconds) return;
    const button = nextButton();
    if (!button) {
      status('Crossfade needs another track in the queue.');
      return;
    }
    const current = job;
    const source = sourceFor(audio);
    if (
      source.status === 'unbound' &&
      source.reason === 'waiting-for-payload-proof' &&
      source.sourceId === current.sourceId &&
      source.generation === current.generation
    ) {
      status('Waiting for stream verification; playback continues normally.');
      return;
    }
    if (
      source.status !== 'bound' ||
      source.sourceId !== current.sourceId ||
      source.generation !== current.generation
    ) {
      cancel('stream identity changed');
      return;
    }
    try {
      current.position = audio.currentTime;
      current.route = graph.beginCrossfade(
        audio,
        current.buffer,
        current.position - current.start,
        settings.rate,
        remaining,
        current.opening,
      );
      current.buffer = null;
      current.opening = null;
      button.click();
      status('Crossfading buffered audio…');
    } catch (error) {
      current.route?.dispose();
      current.route = null;
      status(`Playing normally. ${error.message}`);
    }
  }

  function safeTick() {
    try {
      tick();
    } catch (error) {
      cancel();
      status(`Crossfade stopped. ${error.message}`);
    }
  }

  function reload() {
    cancel();
    try {
      enabled = storage.getItem(enabledKey) === 'true';
      const value = Number(storage.getItem(secondsKey));
      seconds =
        Number.isInteger(value) && value >= 1 && value <= 10 ? value : 5;
    } catch {
      enabled = false;
    }
    timers.clearInterval(timer);
    timer = enabled ? timers.setInterval(safeTick, 100) : undefined;
    status(
      enabled
        ? 'Crossfade enabled. Unavailable streams play normally.'
        : 'Crossfade off.',
    );
    onState?.();
  }

  const events = ['pause', 'seeking', 'playing'];
  function mediaEvent(event) {
    if (event.type === 'playing') {
      safeTick();
      return;
    }
    // Loading the next track may pause/seek the reused element before it starts.
    if (
      job?.route &&
      !job.fading &&
      (event.type === 'seeking' || !job.incomingTrack)
    )
      return;
    cancel(`player ${event.type}`);
  }

  return {
    enabled: () => enabled,
    seconds: () => seconds,
    label: () => message,
    diagnostics() {
      const audio = selected;
      const round = (value) =>
        Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
      let player = null;
      try {
        const source = audio && sourceFor(audio);
        player = audio
          ? {
              paused: audio.paused,
              seeking: audio.seeking,
              readyState: audio.readyState,
              position: round(audio.currentTime),
              duration: round(audio.duration),
              source: source.status,
              sourceReason: source.reason ?? null,
              sourceCapture: sourceStats(),
              graphReady: graph.crossfadeReady(audio, readSettings(audio)),
              rate: readSettings(audio).rate,
              nextBufferedSeconds: round(job?.next?.bufferedSeconds?.()),
              requiredSeconds: round(job?.requiredSeconds),
              handoffErrorSeconds: round(job?.handoffError),
              openingSecondsRemaining: job?.route
                ? round(job.route.endTime - job.route.context.currentTime)
                : null,
            }
          : null;
      } catch (error) {
        player = { error: clean(error.message) };
      }
      return {
        enabled,
        overlapSeconds: seconds,
        status: message,
        stage: job?.failed
          ? 'unavailable'
          : job?.waitingNext
            ? 'finding-next-track'
            : job?.waitingSource
              ? 'identifying-source'
              : job?.fading
                ? 'handing-off'
                : job?.route
                  ? 'buffered-overlap'
                  : job?.decodingOpening
                    ? 'decoding-incoming'
                    : job?.nextReady
                      ? 'ready'
                      : job?.buffer
                        ? 'waiting-for-next-buffer'
                        : job?.next
                          ? 'decoding-outgoing'
                          : 'idle',
        player,
        history: history.map((entry) => ({ ...entry })),
      };
    },
    reload,
    set(nextEnabled, nextSeconds) {
      if (
        typeof nextEnabled !== 'boolean' ||
        !Number.isInteger(nextSeconds) ||
        nextSeconds < 1 ||
        nextSeconds > 10
      )
        throw new TypeError('Choose a crossfade between 1 and 10 seconds.');
      storage.setItem(secondsKey, String(nextSeconds));
      storage.setItem(enabledKey, String(nextEnabled));
      reload();
    },
    select(audio) {
      if (selected === audio) {
        job?.route?.silence(audio);
        return;
      }
      for (const event of events)
        selected?.removeEventListener(event, mediaEvent);
      if (!job?.route) cancel('selected player changed');
      selected = audio;
      for (const event of events) audio.addEventListener(event, mediaEvent);
      job?.route?.silence(audio);
    },
    cancel: () => cancel('playback controls changed'),
    dispose() {
      disposed = true;
      cancel();
      timers.clearInterval(timer);
      for (const event of events)
        selected?.removeEventListener(event, mediaEvent);
      selected = null;
    },
  };
}
