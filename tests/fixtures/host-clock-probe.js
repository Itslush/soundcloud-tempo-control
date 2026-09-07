(operation = null) => {
  const source = (value) =>
    typeof value === 'function'
      ? Function.prototype.toString.call(value)
      : null;
  const own = (object, key) =>
    Object.getOwnPropertyDescriptor(object, key)?.value;

  function properties(object, functions = []) {
    if (!object || !['object', 'function'].includes(typeof object)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(object);
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        {
          kind: 'value' in descriptor ? typeof descriptor.value : 'accessor',
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          value:
            ['boolean', 'string'].includes(typeof descriptor.value) ||
            (typeof descriptor.value === 'number' &&
              Number.isFinite(descriptor.value))
              ? descriptor.value
              : undefined,
          nonFinite:
            typeof descriptor.value === 'number' &&
            !Number.isFinite(descriptor.value)
              ? String(descriptor.value)
              : undefined,
          source: functions.includes(key)
            ? source(descriptor.value)
            : undefined,
          getter: source(descriptor.get),
          setter: source(descriptor.set),
        },
      ]),
    );
  }

  function inspect() {
    const queue = window.webpackJsonp;
    if (!Array.isArray(queue) || queue.push === Array.prototype.push)
      throw new Error('Expected an initialized Webpack JSONP runtime');
    const id = `tempo-clock-inspection-${crypto.randomUUID()}`;
    const sentinel = Object.freeze({ id });
    let runtime;
    const factory = (module, exports, require) => {
      runtime = require;
      module.exports = sentinel;
    };
    const packet = [[], { [id]: factory }, [[id]]];
    const report = { registrationId: id, beforePackets: queue.length };
    try {
      queue.push(packet);
      if (
        !runtime ||
        own(runtime.m, id) !== factory ||
        own(runtime.c, id)?.exports !== sentinel
      )
        throw new Error('Diagnostic-only runtime capture did not complete');
      report.executedDiagnosticModule = true;
      report.cachedModules = {};
      for (const key of ['20', '100', '572', '1280']) {
        const module = own(runtime.c, key);
        if (!module) {
          report.cachedModules[key] = { loaded: false };
          continue;
        }
        const exports = module.exports;
        const details = {
          loaded: module.l,
          exports: properties(exports, [
            'getCurrentSound',
            'getCurrentQueueItem',
          ]),
        };
        if (key !== '20') {
          details.version = exports.version;
          details.buildNumber = exports.buildNumber;
          details.prototypes = {};
          for (const name of [
            'BasePlayer',
            'ProxyPlayer',
            'ProxyPlayerBase',
            'HTML5Player',
            'HTML5PlayerBase',
            'HLSPlayer',
            'HLSMSEPlayer',
          ]) {
            const constructor = exports[name];
            if (typeof constructor !== 'function') continue;
            details.prototypes[name] = properties(constructor.prototype, [
              '_getTruePosition',
              '_getPosition',
              '_updateEndedInState',
              '_shouldBeEnded',
              '_handleDurationChange',
              '_handleDurationUpdates',
              '_updateCachedCurrentTime',
              '_providePlayer',
              '_sync',
              '_updateLocalDurationsFromPlaylist',
            ]);
          }
        }
        report.cachedModules[key] = details;
      }
      const queueExports = own(runtime.c, '20')?.exports;
      const getCurrentSound = own(queueExports, 'getCurrentSound');
      if (
        source(getCurrentSound) !==
        'function(){var e=W.getCurrentQueueItem();return null==e?void 0:e.sound}'
      )
        throw new Error(
          'Current-sound accessor does not match the observed host',
        );
      const sound = getCurrentSound.call(queueExports);
      report.currentSound = properties(sound);
      report.currentSoundPrototype = properties(Object.getPrototypeOf(sound), [
        'getPlayer',
        'getPosition',
      ]);
      const visited = new Map();
      const pending = [{ value: own(sound, 'player'), path: 'sound.player' }];
      report.currentChain = [];
      while (pending.length && report.currentChain.length < 16) {
        const { value: current, path } = pending.shift();
        if (!current || typeof current !== 'object' || visited.has(current))
          continue;
        visited.set(current, path);
        const links = {};
        for (const key of ['player', 'scaudioPlayer', '_player']) {
          const child = own(current, key);
          if (!child || typeof child !== 'object') continue;
          const childPath = `${path}.${key}`;
          links[key] = visited.get(child) || childPath;
          pending.push({ value: child, path: childPath });
        }
        const isPlayer = (moduleId, name) => {
          const prototype = own(runtime.c, moduleId)?.exports[name]?.prototype;
          return Boolean(
            prototype &&
              Object.prototype.isPrototypeOf.call(prototype, current),
          );
        };
        report.currentChain.push({
          path,
          links,
          basePlayer: isPlayer('100', 'BasePlayer'),
          mediaPlayer: isPlayer('572', 'HTML5PlayerBase'),
          hlsPlayer: isPlayer('1280', 'HLSMSEPlayer'),
          own: properties(current),
          prototype: properties(Object.getPrototypeOf(current), [
            'getPlayer',
            'getPosition',
          ]),
          mediaKeys: Object.entries(Object.getOwnPropertyDescriptors(current))
            .filter(
              ([, descriptor]) => descriptor.value instanceof HTMLMediaElement,
            )
            .map(([key, descriptor]) => ({
              key,
              currentTime: descriptor.value.currentTime,
              duration: descriptor.value.duration,
              paused: descriptor.value.paused,
              src: descriptor.value.getAttribute('src'),
            })),
          mediaState: properties(own(current, '_mediaElementAndState')),
          nestedMediaKeys: Object.entries(
            Object.getOwnPropertyDescriptors(
              own(current, '_mediaElementAndState') || {},
            ),
          )
            .filter(
              ([, descriptor]) => descriptor.value instanceof HTMLMediaElement,
            )
            .map(([key, descriptor]) => ({
              key,
              currentTime: descriptor.value.currentTime,
              duration: descriptor.value.duration,
              paused: descriptor.value.paused,
              src: descriptor.value.getAttribute('src'),
            })),
        });
      }
      if (pending.length)
        throw new Error('Current player graph exceeds the inspection bound');
      report.scripts = [...document.scripts]
        .map((script) => script.src)
        .filter((url) => url.startsWith('https://a-v2.sndcdn.com/assets/'));
      if (operation) report.operation = operation(runtime);
    } finally {
      if (runtime && own(runtime.m, id) === factory) delete runtime.m[id];
      if (runtime && own(runtime.c, id)?.exports === sentinel)
        delete runtime.c[id];
      const index = queue.indexOf(packet);
      if (index !== -1) queue.splice(index, 1);
      report.cleanup = {
        factoryRemoved: runtime ? !Object.hasOwn(runtime.m, id) : null,
        moduleRemoved: runtime ? !Object.hasOwn(runtime.c, id) : null,
        packetRemoved: !queue.includes(packet),
        afterPackets: queue.length,
      };
    }
    return report;
  }

  return inspect();
};
