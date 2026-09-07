(() => {
  if (location.origin !== 'https://soundcloud.com') return;
  const media = new Set();
  const changes = [];
  const describe = (result) => {
    const value = { ...result };
    if (value.playlistUrl) {
      const url = new URL(value.playlistUrl);
      value.playlistHost = url.hostname;
      value.playlistPath = url.pathname;
      delete value.playlistUrl;
    }
    return value;
  };
  const binding = createSourceBinding({
    onChange(audio, result) {
      if (changes.length < 40) changes.push(describe(result));
    },
  });
  const installed = binding.install();
  const originalPlay = HTMLMediaElement.prototype.play;
  const play = function (...args) {
    if (media.size < 8) media.add(this);
    this.muted = true;
    binding.resolve(this);
    return Reflect.apply(originalPlay, this, args);
  };
  HTMLMediaElement.prototype.play = play;
  const snapshot = () => ({
    installed,
    changes: [...changes],
    media: [...media].map((audio) => ({
      currentTime: audio.currentTime,
      paused: audio.paused,
      currentSourceKind: audio.currentSrc.startsWith('blob:')
        ? 'blob'
        : audio.currentSrc
          ? 'url'
          : 'empty',
      binding: describe(binding.resolve(audio)),
    })),
    stats: binding.stats(),
  });
  globalThis.sourceBindingProbe = {
    snapshot,
    stop() {
      for (const audio of media) audio.pause();
      return snapshot();
    },
    async verify() {
      await binding.settle();
      const before = snapshot();
      const bound = [...media].find(
        (audio) => binding.resolve(audio).status === 'bound',
      );
      if (!installed || !bound) return { status: 'UNBOUND', before };
      const selected = binding.resolve(bound);
      binding.invalidate(bound);
      const invalidated = binding.resolve(bound);
      const passed =
        selected.sourceId !== null &&
        selected.proof === 'sha256-mdat-blocks' &&
        invalidated.status === 'unbound' &&
        invalidated.generation > selected.generation;
      await binding.dispose();
      if (HTMLMediaElement.prototype.play === play)
        HTMLMediaElement.prototype.play = originalPlay;
      const stats = binding.stats();
      const clean =
        stats.parsers === 0 &&
        stats.media === 0 &&
        stats.sources === 0 &&
        stats.pendingHashBytes === 0 &&
        stats.scratchBytes === 0 &&
        stats.digestBytes === 0;
      return {
        status: passed && clean ? 'PASSED' : 'FAILED',
        before,
        selected: describe(selected),
        invalidated: describe(invalidated),
        stats,
        cleanupPassed: clean,
      };
    },
    async dispose() {
      for (const audio of media) audio.pause();
      await binding.dispose();
      if (HTMLMediaElement.prototype.play === play)
        HTMLMediaElement.prototype.play = originalPlay;
      return binding.stats();
    },
  };
})();
