(() => {
  if (location.origin !== 'https://soundcloud.com') return;
  const types = new Set([
    'play',
    'playing',
    'pause',
    'timeupdate',
    'seeking',
    'seeked',
    'ended',
  ]);
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativePause = HTMLMediaElement.prototype.pause;
  const nativePaused = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'paused',
  ).get;
  const nativeTime = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'currentTime',
  ).get;
  const targets = new WeakMap();
  const media = new Set();
  const registrations = [];
  const deliveries = [];
  let nextTarget = 0;
  let origin = 'host';
  let phase = 'baseline';
  let facade;
  let handle;
  let owned;
  let overflow = false;
  const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  const captureOf = (options) =>
    typeof options === 'boolean' ? options : !!options?.capture;
  const targetInfo = (target) => {
    if (!targets.has(target))
      targets.set(target, { id: ++nextTarget, listeners: new Map() });
    const value = targets.get(target);
    return {
      id: value.id,
      kind:
        target === window
          ? 'window'
          : target === document
            ? 'document'
            : target?.tagName?.toLowerCase() ||
              target?.constructor?.name ||
              'unknown',
    };
  };
  const add = function (type, listener, options) {
    if (
      !types.has(type) ||
      !listener ||
      (typeof listener !== 'function' &&
        typeof listener.handleEvent !== 'function')
    )
      return Reflect.apply(nativeAdd, this, arguments);
    if (registrations.length >= 256) {
      overflow = true;
      return Reflect.apply(nativeAdd, this, arguments);
    }
    const info = targetInfo(this);
    const slots = targets.get(this).listeners;
    const capture = captureOf(options);
    const key = `${type}:${capture}`;
    if (!slots.has(key)) slots.set(key, new WeakMap());
    const listeners = slots.get(key);
    let entry = listeners.get(listener);
    if (!entry) {
      entry = {
        id: registrations.length + 1,
        type,
        capture,
        target: info,
        origin,
        callback:
          typeof listener === 'function'
            ? listener.name || 'anonymous'
            : 'handleEvent',
        stack: String(new Error().stack)
          .split('\n')
          .slice(2, 5)
          .map((line) => line.replace(/\?[^\s):]*/g, '').slice(0, 250)),
        removed: 0,
      };
      registrations.push(entry);
      const target = this;
      entry.wrapper = function (event) {
        if (deliveries.length < 512)
          deliveries.push({
            registration: entry.id,
            origin: entry.origin,
            type,
            phase,
            capture,
            eventPhase: event.eventPhase,
            trusted: event.isTrusted,
            target: targetInfo(event.target),
            currentTarget: targetInfo(target),
            facadeOwned: facade?.owns(event.target) || false,
            reportedPaused:
              event.target instanceof HTMLMediaElement
                ? event.target.paused
                : null,
            actualPaused:
              event.target instanceof HTMLMediaElement
                ? Reflect.apply(nativePaused, event.target, [])
                : null,
          });
        if (typeof listener === 'function')
          return Reflect.apply(listener, this, [event]);
        return listener.handleEvent(event);
      };
      listeners.set(listener, entry);
    }
    return Reflect.apply(nativeAdd, this, [type, entry.wrapper, options]);
  };
  const remove = function (type, listener, options) {
    const entry = targets
      .get(this)
      ?.listeners.get(`${type}:${captureOf(options)}`)
      ?.get(listener);
    if (entry) entry.removed++;
    return Reflect.apply(nativeRemove, this, [
      type,
      entry?.wrapper || listener,
      options,
    ]);
  };
  EventTarget.prototype.addEventListener = add;
  EventTarget.prototype.removeEventListener = remove;
  const play = function (...args) {
    if (media.size < 8) media.add(this);
    this.muted = true;
    return Reflect.apply(nativePlay, this, args);
  };
  HTMLMediaElement.prototype.play = play;
  const ui = () => {
    const button = document.querySelector('.playControls__play');
    return button
      ? {
          title: button.getAttribute('title'),
          label: button.getAttribute('aria-label'),
          classes: button.className,
        }
      : null;
  };
  const snapshot = () => ({
    overflow,
    phase,
    registrations: registrations.map(({ wrapper, ...entry }) => entry),
    deliveries: [...deliveries],
    media: [...media].map((audio) => ({
      ...targetInfo(audio),
      currentTime: Reflect.apply(nativeTime, audio, []),
      actualPaused: Reflect.apply(nativePaused, audio, []),
      reportedPaused: audio.paused,
      connected: audio.isConnected,
      parent: audio.parentElement?.tagName || null,
      root: targetInfo(audio.getRootNode()),
      owns: facade?.owns(audio) || false,
    })),
    ui: ui(),
  });
  globalThis.mediaListenersProbe = {
    snapshot,
    getMedia() {
      return (
        [...media].find((audio) => !Reflect.apply(nativePaused, audio, [])) ||
        [...media][0]
      );
    },
    async run() {
      const audio = this.getMedia();
      if (!audio) throw new Error('No public media element was observed');
      owned = audio;
      const before = snapshot();
      const witness = [];
      const early = (event) =>
        witness.push({
          type: event.type,
          trusted: event.isTrusted,
          phase,
          eventPhase: event.eventPhase,
        });
      Reflect.apply(nativeAdd, audio, ['pause', early, true]);
      origin = 'facade';
      facade = createMediaFacade();
      let state = {
        state: 'playing',
        paused: false,
        ended: false,
        position: Reflect.apply(nativeTime, audio, []),
        duration: audio.duration,
        sampleRate: 44100,
        scheduledWindows: 1,
      };
      const operations = [];
      const transport = {
        snapshot: () => ({ ...state }),
        play() {
          operations.push('play');
          state = { ...state, state: 'playing', paused: false };
        },
        pause() {
          operations.push('pause');
          state = { ...state, state: 'paused', paused: true };
        },
        seek(position) {
          operations.push('seek');
          state = { ...state, position };
        },
        dispose() {
          operations.push('dispose');
        },
      };
      handle = facade.bind(audio, { transport });
      origin = 'host';
      phase = 'native-pause-owned';
      Reflect.apply(nativePause, audio, []);
      await delay(600);
      const afterNativePause = snapshot();
      phase = 'facade-events';
      state = {
        ...state,
        position: state.position + 1,
        state: 'paused',
        paused: true,
      };
      handle.update(state);
      await delay(300);
      const afterFacadePause = snapshot();
      phase = 'dispose';
      await facade.dispose();
      Reflect.apply(nativeRemove, audio, ['pause', early, true]);
      Reflect.apply(nativePause, audio, []);
      const hostRaw = deliveries.filter(
        (event) =>
          event.origin === 'host' &&
          event.phase === 'native-pause-owned' &&
          event.trusted,
      );
      const hostSynthetic = deliveries.filter(
        (event) =>
          event.origin === 'host' &&
          event.phase === 'facade-events' &&
          !event.trusted,
      );
      return {
        before,
        afterNativePause,
        afterFacadePause,
        hostRaw,
        hostSynthetic,
        witness,
        operations,
        status: overflow ? 'INCONCLUSIVE' : 'OBSERVED',
        disposed: !facade.owns(audio),
      };
    },
    async stop() {
      await facade?.dispose();
      for (const audio of media) Reflect.apply(nativePause, audio, []);
      if (EventTarget.prototype.addEventListener === add)
        EventTarget.prototype.addEventListener = nativeAdd;
      if (EventTarget.prototype.removeEventListener === remove)
        EventTarget.prototype.removeEventListener = nativeRemove;
      if (HTMLMediaElement.prototype.play === play)
        HTMLMediaElement.prototype.play = nativePlay;
      return {
        nativePaused: [...media].every((audio) =>
          Reflect.apply(nativePaused, audio, []),
        ),
        owned: owned ? facade?.owns(owned) || false : false,
      };
    },
  };
})();
