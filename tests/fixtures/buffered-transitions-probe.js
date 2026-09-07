(() => {
  if (window.top !== window || location.origin !== 'https://soundcloud.com')
    return;
  const descriptors = Object.getOwnPropertyDescriptors(
    HTMLMediaElement.prototype,
  );
  const create = AudioContext.prototype.createMediaElementSource;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const records = [];
  const events = [];
  const tailEvents = [];
  const dispatches = [];
  const dispatchIds = new WeakMap();
  let sequence = 0;
  let observingTail = false;
  let tailStarted = null;
  let observationErrors = 0;
  const dropped = { events: 0, tailEvents: 0, dispatches: 0 };
  const read = (audio, name) => descriptors[name]?.get?.call(audio);
  const source = (audio) => ({
    src: read(audio, 'src'),
    currentSrc: read(audio, 'currentSrc'),
  });
  const retain = (list, item, name, limit) => {
    if (list.length >= limit) {
      list.shift();
      dropped[name]++;
    }
    list.push(item);
  };
  const describe = (audio) => ({
    time: performance.now(),
    source: source(audio),
    position: audio.currentTime,
    nativePosition: read(audio, 'currentTime'),
    duration: Number.isFinite(audio.duration) ? audio.duration : null,
    nativeDuration: Number.isFinite(read(audio, 'duration'))
      ? read(audio, 'duration')
      : null,
    ended: audio.ended,
    nativeEnded: read(audio, 'ended'),
    paused: audio.paused,
    nativePaused: read(audio, 'paused'),
    playbackRate: audio.playbackRate,
    loadedTrack:
      document.querySelector(
        '.playControls__soundBadge .playbackSoundBadge__titleLink',
      )?.pathname ?? null,
  });
  const observe = (operation) => {
    try {
      return operation();
    } catch {
      observationErrors++;
      return null;
    }
  };
  const dispatchWrapper = function (event) {
    let record = null;
    if (
      observingTail &&
      (event?.type === 'ended' || event?.type === 'timeupdate')
    )
      observe(() => {
        const id = records.findIndex(({ audio }) => audio === this);
        if (id < 0) return;
        record = {
          sequence: ++sequence,
          id,
          name: event.type,
          trusted: event.isTrusted,
          before: describe(this),
          after: null,
          returned: null,
        };
        dispatchIds.set(event, record.sequence);
        retain(dispatches, record, 'dispatches', 512);
      });
    try {
      const returned = Reflect.apply(dispatch, this, arguments);
      if (record)
        observe(() => {
          record.returned = returned;
        });
      return returned;
    } finally {
      if (record)
        observe(() => {
          record.after = describe(this);
        });
    }
  };
  EventTarget.prototype.dispatchEvent = dispatchWrapper;
  AudioContext.prototype.createMediaElementSource = function (audio) {
    const result = Reflect.apply(create, this, [audio]);
    if (records.length >= 8)
      throw new Error('Transition observation media limit exceeded');
    const id = records.length;
    const listeners = [];
    for (const name of [
      'loadstart',
      'loadedmetadata',
      'emptied',
      'ended',
      'seeking',
      'seeked',
      'timeupdate',
    ]) {
      const listener = (event) => {
        if (name === 'timeupdate' && !observingTail) return;
        observe(() => {
          const value = {
            sequence: ++sequence,
            id,
            name,
            trusted: event.isTrusted,
            dispatchSequence: dispatchIds.get(event) ?? null,
            ...describe(audio),
          };
          if (name === 'timeupdate')
            retain(tailEvents, value, 'tailEvents', 512);
          else retain(events, value, 'events', 256);
        });
      };
      const capture = name === 'ended' || name === 'timeupdate';
      audio.addEventListener(name, listener, capture);
      listeners.push([name, listener, capture]);
    }
    records.push({ audio, listeners });
    return result;
  };
  globalThis.bufferedTransitionsProbe = {
    snapshot() {
      const badge = document.querySelector(
        '.playControls__soundBadge .playbackSoundBadge__titleLink',
      );
      return {
        ...bufferedPlayerProbe.snapshot(),
        loadedTrack: badge ? new URL(badge.href).pathname : null,
        loadedTitle: badge?.textContent?.trim() ?? null,
        pagePath: location.pathname,
        sources: records.map(({ audio }, id) => ({
          id,
          ...source(audio),
          connected: audio.isConnected,
          seeking: audio.seeking,
        })),
        mediaEvents: events.slice(),
        tailObservation: {
          started: tailStarted,
          active: observingTail,
          errors: observationErrors,
          dropped: { ...dropped },
          timeupdates: tailEvents.slice(),
          dispatches: dispatches.slice(),
        },
      };
    },
    beginTail() {
      tailEvents.length = 0;
      dispatches.length = 0;
      dropped.tailEvents = 0;
      dropped.dispatches = 0;
      observingTail = true;
      tailStarted = { sequence, time: performance.now() };
      return { ...tailStarted };
    },
    endTail() {
      observingTail = false;
    },
    inventory() {
      return {
        path: location.pathname,
        links: [...document.querySelectorAll('a[href]')]
          .filter(
            (link) =>
              new URL(link.href).origin === location.origin &&
              /^\/nasa\/[^/]+$/.test(new URL(link.href).pathname),
          )
          .map((link) => ({
            href: new URL(link.href).pathname,
            text: link.textContent.trim().slice(0, 100),
            className: link.className,
          }))
          .slice(0, 100),
        rows: [...document.querySelectorAll('.soundList__item')]
          .slice(0, 8)
          .map((row) => ({
            text: row.textContent.trim().slice(0, 350),
            html: row.outerHTML.slice(0, 6000),
          })),
        controls: [
          ...document.querySelectorAll('.playControls button,.playControls a'),
        ].map((node) => ({
          tag: node.tagName,
          title: node.title,
          aria: node.getAttribute('aria-label'),
          className: node.className,
          text: node.textContent.trim().slice(0, 100),
        })),
      };
    },
    queue() {
      return [...document.querySelectorAll('.queueItemView')]
        .slice(0, 40)
        .map((row) => {
          const link = row.querySelector(
            'a.queueItemView__title, .queueItemView__title a',
          );
          return {
            path: link ? new URL(link.href).pathname : null,
            title: link?.textContent?.trim() ?? null,
            className: row.className,
            ariaCurrent: row.getAttribute('aria-current'),
            visible:
              row.getBoundingClientRect().width > 0 &&
              row.getBoundingClientRect().height > 0,
            html: row.outerHTML.slice(0, 4000),
          };
        });
    },
    stop() {
      observingTail = false;
      if (EventTarget.prototype.dispatchEvent === dispatchWrapper)
        EventTarget.prototype.dispatchEvent = dispatch;
      for (const { audio, listeners } of records)
        for (const [name, listener, capture] of listeners)
          audio.removeEventListener(name, listener, capture);
    },
  };
})();
