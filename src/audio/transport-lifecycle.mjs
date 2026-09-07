const transitions = Object.freeze({
  IDLE: ['BUFFERING', 'SEEKING', 'DISPOSED'],
  BUFFERING: ['IDLE', 'PLAYING', 'SEEKING', 'DISPOSED'],
  PLAYING: ['IDLE', 'BUFFERING', 'SEEKING', 'DISPOSED'],
  SEEKING: ['IDLE', 'BUFFERING', 'DISPOSED'],
  DISPOSED: [],
});

export function createTransportLifecycle() {
  let phase = 'IDLE';
  let resumeAfterSeek = false;

  function transition(next) {
    if (next === phase) return;
    if (!transitions[phase].includes(next))
      throw new Error(`Invalid transport transition: ${phase} to ${next}`);
    phase = next;
  }

  function wanted() {
    return phase === 'SEEKING'
      ? resumeAfterSeek
      : phase === 'BUFFERING' || phase === 'PLAYING';
  }

  return Object.freeze({
    get phase() {
      return phase;
    },
    get wanted() {
      return wanted();
    },
    get disposed() {
      return phase === 'DISPOSED';
    },
    play() {
      if (phase === 'SEEKING') resumeAfterSeek = true;
      else transition('BUFFERING');
    },
    stop() {
      transition('IDLE');
      resumeAfterSeek = false;
    },
    seek() {
      resumeAfterSeek = wanted();
      transition('SEEKING');
    },
    settled() {
      if (phase !== 'SEEKING') return;
      transition(resumeAfterSeek ? 'BUFFERING' : 'IDLE');
      resumeAfterSeek = false;
    },
    render(active) {
      if (phase !== 'BUFFERING' && phase !== 'PLAYING') return;
      transition(active ? 'PLAYING' : 'BUFFERING');
    },
    dispose() {
      transition('DISPOSED');
      resumeAfterSeek = false;
    },
  });
}
