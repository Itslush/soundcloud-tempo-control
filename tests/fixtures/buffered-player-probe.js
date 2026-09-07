(() => {
  if (location.origin !== 'https://soundcloud.com' || window.top !== window)
    return;
  const descriptors = Object.getOwnPropertyDescriptors(
    HTMLMediaElement.prototype,
  );
  const create = AudioContext.prototype.createMediaElementSource;
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  const media = [];
  const rateEvents = [];
  const commandEvents = [];
  const clickEvents = [];
  const commandIds = new WeakMap();
  const commandRestores = [];
  let nextCommandId = 0;
  const documentId = crypto.randomUUID();
  const contexts = new Map();
  let selected = null;
  let stopped = false;
  const read = (audio, key) => descriptors[key]?.get?.call(audio);

  const clickListener = (event) => {
    if (clickEvents.length >= 128) return;
    const target = event.composedPath().find((node) => node instanceof Element);
    const control =
      target?.closest('button,[role="button"],input,summary') || target;
    clickEvents.push({
      time: performance.now(),
      isTrusted: event.isTrusted,
      tag: control?.tagName,
      id: control?.id,
      title: control?.getAttribute('title'),
      label: control?.getAttribute('aria-label'),
      text: control?.textContent?.trim().slice(0, 100),
    });
  };
  document.addEventListener('click', clickListener, true);

  function hostStorage() {
    const result = {};
    for (const key of Object.keys(localStorage)) {
      if (
        !/play|queue|current|position/i.test(key) ||
        key.startsWith('soundcloud.tempo.')
      )
        continue;
      const value = localStorage.getItem(key);
      const facts = {};
      function collect(item, path = '', depth = 0) {
        if (depth > 5 || item === null || typeof item !== 'object') return;
        for (const [name, child] of Object.entries(item).slice(0, 40)) {
          const next = path ? `${path}.${name}` : name;
          if (
            /^(playing|paused|isPlaying|isPaused|position|currentTime|playbackRate|state|status)$/i.test(
              name,
            ) &&
            ['boolean', 'number', 'string'].includes(typeof child)
          )
            facts[next] =
              typeof child === 'string' ? child.slice(0, 50) : child;
          else if (typeof child === 'object') collect(child, next, depth + 1);
        }
      }
      try {
        collect(JSON.parse(value));
      } catch {}
      result[key] = { bytes: value?.length ?? 0, facts };
    }
    return result;
  }

  function sink(context) {
    if (contexts.has(context)) return contexts.get(context);
    if (contexts.size >= 4)
      throw new Error('Diagnostic context limit exceeded');
    const analyser = context.createAnalyser();
    analyser.fftSize = 16384;
    const gain = context.createGain();
    gain.gain.value = 0;
    connect.call(analyser, gain);
    connect.call(gain, context.destination);
    const record = {
      context,
      analyser,
      gain,
      samples: new Float32Array(analyser.fftSize),
    };
    contexts.set(context, record);
    return record;
  }

  AudioContext.prototype.createMediaElementSource = function (audio) {
    const source = Reflect.apply(create, this, [audio]);
    if (media.length >= 8) throw new Error('Diagnostic media limit exceeded');
    const id = media.length;
    const context = this;
    const rateListener = (event) => {
      if (rateEvents.length >= 64) return;
      rateEvents.push({
        id,
        contextTime: context.currentTime,
        playbackRate: audio.playbackRate,
        defaultPlaybackRate: audio.defaultPlaybackRate,
        nativePlaybackRate: read(audio, 'playbackRate'),
        nativeDefaultPlaybackRate: read(audio, 'defaultPlaybackRate'),
        isTrusted: event.isTrusted,
      });
    };
    audio.addEventListener('ratechange', rateListener);
    media.push({ audio, context, rateListener });
    return source;
  };
  AudioNode.prototype.connect = function (...args) {
    const destination = args[0];
    if (destination === this.context.destination) {
      const record = sink(this.context);
      Reflect.apply(connect, this, [record.analyser, ...args.slice(1)]);
      return destination;
    }
    return Reflect.apply(connect, this, args);
  };
  AudioNode.prototype.disconnect = function (...args) {
    const record = contexts.get(this.context);
    if (record && args[0] === this.context.destination)
      return Reflect.apply(disconnect, this, [
        record.analyser,
        ...args.slice(1),
      ]);
    return Reflect.apply(disconnect, this, args);
  };

  function describe({ audio, context }, id) {
    const before = context.currentTime;
    const position = audio.currentTime;
    const after = context.currentTime;
    const record = contexts.get(context);
    let peak = null;
    let finite = null;
    if (record) {
      record.analyser.getFloatTimeDomainData(record.samples);
      finite = record.samples.every(Number.isFinite);
      peak = 0;
      for (const sample of record.samples)
        peak = Math.max(peak, Math.abs(sample));
    }
    return {
      id,
      commandId: commandIds.get(audio) ?? null,
      before,
      after,
      position,
      nativePosition: read(audio, 'currentTime'),
      paused: audio.paused,
      nativePaused: read(audio, 'paused'),
      ended: audio.ended,
      playbackRate: audio.playbackRate,
      defaultPlaybackRate: audio.defaultPlaybackRate,
      nativePlaybackRate: read(audio, 'playbackRate'),
      nativeDefaultPlaybackRate: read(audio, 'defaultPlaybackRate'),
      volume: audio.volume,
      muted: audio.muted,
      duration: Number.isFinite(audio.duration) ? audio.duration : null,
      sourceKind: audio.currentSrc.startsWith('blob:')
        ? 'blob'
        : audio.currentSrc
          ? 'url'
          : 'empty',
      contextState: context.state,
      contextSampleRate: context.sampleRate,
      sinkGain: record?.gain.gain.value ?? null,
      peak,
      finite,
    };
  }

  function snapshot() {
    return {
      documentId,
      media: media.map(describe),
      selected: selected === null ? null : describe(media[selected], selected),
      contexts: [...contexts.values()].map(({ context, gain }) => ({
        state: context.state,
        sampleRate: context.sampleRate,
        sinkGain: gain.gain.value,
      })),
      panelCount: document.querySelectorAll('#soundcloud-tempo-control').length,
      label:
        document
          .querySelector('#soundcloud-tempo-control')
          ?.shadowRoot?.querySelector('#wasm-status')?.textContent ?? null,
      stopped,
      rateEvents: rateEvents.slice(),
      commandEvents: commandEvents.slice(),
      clickEvents: clickEvents.slice(),
      hostStorage: hostStorage(),
      heroAction:
        document
          .querySelector('.soundTitle__playButtonHero .playButton')
          ?.getAttribute('title') ?? null,
      footerAction:
        document.querySelector('.playControls__play')?.getAttribute('title') ??
        null,
    };
  }

  globalThis.bufferedPlayerProbe = {
    async monitorOutput(source) {
      const record = contexts.get(media[selected]?.context);
      if (!record || record.monitor) throw new Error('Invalid output monitor state');
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        await record.context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      record.monitor = new AudioWorkletNode(record.context, 'tempo-continuous-output');
      connect.call(record.analyser, record.monitor);
      connect.call(record.monitor, record.gain);
    },
    readOutputMonitor() {
      const monitor = contexts.get(media[selected]?.context)?.monitor;
      if (!monitor) throw new Error('No output monitor');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Output monitor timed out')), 5000);
        monitor.port.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        monitor.port.postMessage(null);
      });
    },
    snapshot,
    observeCommands() {
      if (commandRestores.length)
        throw new Error('Command observation already installed');
      for (const name of ['play', 'pause']) {
        const original = HTMLMediaElement.prototype[name];
        const wrapper = function (...args) {
          if (!commandIds.has(this)) commandIds.set(this, nextCommandId++);
          const event =
            commandEvents.length < 128
              ? {
                  name,
                  time: performance.now(),
                  commandId: commandIds.get(this),
                  source: {
                    src: read(this, 'src'),
                    currentSrc: read(this, 'currentSrc'),
                  },
                  paused: this.paused,
                  ended: this.ended,
                  seeking: this.seeking,
                  duration: Number.isFinite(this.duration)
                    ? this.duration
                    : null,
                  nativePaused: read(this, 'paused'),
                  nativeEnded: read(this, 'ended'),
                  position: this.currentTime,
                  nativePosition: read(this, 'currentTime'),
                  playbackRate: this.playbackRate,
                  userActivation: navigator.userActivation.isActive,
                  stack: new Error().stack?.slice(0, 3000),
                  sourceAfter: {
                    src: read(this, 'src'),
                    currentSrc: read(this, 'currentSrc'),
                  },
                }
              : null;
          if (event) commandEvents.push(event);
          const result = Reflect.apply(original, this, args);
          if (event) event.returnedPromise = result instanceof Promise;
          return result;
        };
        HTMLMediaElement.prototype[name] = wrapper;
        commandRestores.push(() => {
          if (HTMLMediaElement.prototype[name] === wrapper)
            HTMLMediaElement.prototype[name] = original;
        });
      }
    },
    select(id) {
      if (!Number.isInteger(id) || !media[id])
        throw new Error('Unknown observed media');
      selected = id;
      return snapshot();
    },
    mute(value) {
      if (selected === null || typeof value !== 'boolean')
        throw new Error('No selected media');
      media[selected].audio.muted = value;
      return snapshot();
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        document.removeEventListener('click', clickListener, true);
        for (const restore of commandRestores) restore();
        for (const { audio, rateListener } of media) {
          audio.pause();
          descriptors.pause.value.call(audio);
          audio.removeEventListener('ratechange', rateListener);
        }
        for (const context of new Set([
          ...media.map((entry) => entry.context),
          ...contexts.keys(),
        ]))
          if (context.state !== 'closed') await context.close();
        for (const { analyser, gain, monitor } of contexts.values()) {
          if (monitor) {
            monitor.port.close();
            disconnect.call(monitor);
          }
          disconnect.call(analyser);
          disconnect.call(gain);
        }
      }
      return snapshot();
    },
  };
})();
