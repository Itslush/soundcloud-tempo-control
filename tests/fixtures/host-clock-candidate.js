(createHostClock, runtime, expected) => {
  if (window.hostClockCandidateTest)
    throw new Error('A test candidate is already installed');
  const own = (value, key) =>
    Object.getOwnPropertyDescriptor(value, key)?.value;
  const exports = (id) => own(runtime.c, id)?.exports;
  const queue = exports('20');
  const base = exports('100');
  const mediaModule = exports('572');
  const hls = exports('1280');
  for (const module of [base, mediaModule, hls])
    if (module.version !== '32.0.0' || module.buildNumber !== 2285)
      throw new Error('Unsupported host SDK version');
  const prototypes = {
    BasePlayer: base.BasePlayer.prototype,
    HTML5PlayerBase: mediaModule.HTML5PlayerBase.prototype,
    HLSMSEPlayer: hls.HLSMSEPlayer.prototype,
  };
  for (const { prototype, method, source } of expected) {
    const value = own(prototypes[prototype], method);
    if (
      typeof value !== 'function' ||
      Function.prototype.toString.call(value) !== source
    )
      throw new Error(`Host implementation changed: ${prototype}.${method}`);
  }
  const getCurrentSound = own(queue, 'getCurrentSound');
  if (
    Function.prototype.toString.call(getCurrentSound) !==
      'function(){var e=W.getCurrentQueueItem();return null==e?void 0:e.sound}' ||
    Function.prototype.toString.call(own(queue, 'getCurrentQueueItem')) !==
      'function(){return P.at(I)}'
  )
    throw new Error('Host sound accessor changed');

  function chain() {
    const sound = getCurrentSound.call(queue);
    const wrapper = sound && own(sound, 'player');
    let player = wrapper && own(wrapper, 'player');
    const nodes = [];
    while (player && nodes.length < 8) {
      if (
        nodes.includes(player) ||
        !Object.prototype.isPrototypeOf.call(prototypes.BasePlayer, player)
      )
        return null;
      nodes.push(player);
      const state = own(player, '_mediaElementAndState');
      if (state) {
        const media = own(state, 'element');
        return media instanceof HTMLMediaElement
          ? { nodes, media, player }
          : null;
      }
      player = own(player, '_player');
    }
    return null;
  }

  const selected = chain();
  if (!selected) throw new Error('No validated current player chain');
  const { media, player } = selected;
  if (media.playbackRate !== 0.025 || media.paused)
    throw new Error('Candidate requires an already-playing low-rate source');
  const originalSource = media.getAttribute('src');
  if (!originalSource?.startsWith('blob:https://soundcloud.com/'))
    throw new Error('Expected an observed SoundCloud blob source');
  const original = expected.map(({ prototype, method }) => ({
    prototype,
    method,
    descriptor: Object.getOwnPropertyDescriptor(prototypes[prototype], method),
  }));
  const failures = [];
  let updates = 0;
  const adapter = createHostClock({
    basePrototype: prototypes.BasePlayer,
    mediaPrototype: prototypes.HTML5PlayerBase,
    leafPrototypes: [prototypes.HLSMSEPlayer],
    onFailure(audio, error) {
      failures.push({ name: error.name, message: error.message });
      audio.pause();
    },
  });
  const binding = adapter.bind(media, {
    snapshot: () => ({
      position: media.currentTime,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      ended: media.ended,
      paused: media.paused,
    }),
    sourceMatches(candidate) {
      if (media.getAttribute('src') !== originalSource) return false;
      const current = chain();
      return Boolean(
        current?.media === media &&
          (!candidate || current.nodes.includes(candidate)),
      );
    },
  });
  const update = () => {
    updates++;
    binding.update();
  };
  media.addEventListener('timeupdate', update);
  media.addEventListener('durationchange', update);
  update();
  const snapshot = () => ({
    active: binding.active,
    updates,
    failures: [...failures],
    sourceUnchanged: media.getAttribute('src') === originalSource,
    position: media.currentTime,
    duration: Number.isFinite(media.duration) ? media.duration : null,
    ended: media.ended,
    paused: media.paused,
  });
  window.hostClockCandidateTest = {
    snapshot,
    async stop() {
      media.removeEventListener('timeupdate', update);
      media.removeEventListener('durationchange', update);
      binding.release();
      await binding.restoration;
      await adapter.dispose();
      const duration = Object.getOwnPropertyDescriptor(player, '_duration');
      const result = {
        ...snapshot(),
        methodsRestored: original.every(({ prototype, method, descriptor }) => {
          const current = Object.getOwnPropertyDescriptor(
            prototypes[prototype],
            method,
          );
          return [
            'value',
            'get',
            'set',
            'writable',
            'enumerable',
            'configurable',
          ].every((key) => current?.[key] === descriptor[key]);
        }),
        durationRestoredToData: Boolean(duration && 'value' in duration),
      };
      delete window.hostClockCandidateTest;
      return result;
    },
  };
  return {
    ...snapshot(),
    source: originalSource,
    chainLength: selected.nodes.length,
  };
};
