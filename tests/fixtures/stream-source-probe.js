(() => {
  if (location.origin !== 'https://soundcloud.com') return;
  const limit = 2 * 1024 * 1024;
  const records = [];
  const chunks = [];
  const media = new Set();
  const sources = new WeakMap();
  let retainedBytes = 0;
  let nextSource = 0;
  let sequence = 0;
  const record = (kind, value) => {
    if (records.length < 80) records.push({ kind, ...value });
  };
  const describe = (audio) => ({
    sourceKind: audio.currentSrc.startsWith('blob:')
      ? 'blob'
      : audio.currentSrc
        ? 'url'
        : 'empty',
    sourceHost: (() => {
      try {
        return new URL(audio.currentSrc).hostname;
      } catch {
        return '';
      }
    })(),
    crossOrigin: audio.crossOrigin,
    duration: Number.isFinite(audio.duration) ? audio.duration : null,
    currentTime: audio.currentTime,
    paused: audio.paused,
  });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    media.add(this);
    this.muted = true;
    record('play', describe(this));
    return Reflect.apply(play, this, args);
  };
  if (globalThis.MediaSource) {
    const add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const source = Reflect.apply(add, this, [mime]);
      const id = ++nextSource;
      sources.set(source, { id, mime });
      record('sourceBuffer', { id, mime });
      return source;
    };
    const append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (buffer) {
      const info = sources.get(this);
      const bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
      const entry = {
        sequence: ++sequence,
        ...info,
        bytes: bytes.byteLength,
        timestampOffset: this.timestampOffset,
        appendWindowStart: this.appendWindowStart,
        appendWindowEnd: Number.isFinite(this.appendWindowEnd)
          ? this.appendWindowEnd
          : null,
        mode: this.mode,
        header: Array.from(bytes.subarray(0, 24)),
      };
      if (chunks.length < 8 && retainedBytes + bytes.byteLength <= limit) {
        chunks.push({ ...entry, data: bytes.slice() });
        retainedBytes += bytes.byteLength;
      }
      record('append', entry);
      return Reflect.apply(append, this, [buffer]);
    };
  }
  const create = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (audio) {
    media.add(audio);
    record('mediaNode', describe(audio));
    return Reflect.apply(create, this, [audio]);
  };
  window.streamSourceProbe = {
    snapshot() {
      return {
        records,
        retainedBytes,
        limit,
        chunks: chunks.map(({ data, ...value }) => value),
        media: [...media].map(describe),
        audioDecoder: typeof AudioDecoder === 'function',
      };
    },
    chunk(index) {
      const data = chunks[index]?.data;
      if (!data) return null;
      let binary = '';
      for (let start = 0; start < data.length; start += 8192)
        binary += String.fromCharCode(...data.subarray(start, start + 8192));
      return btoa(binary);
    },
    stop() {
      for (const audio of media) audio.pause();
      const result = this.snapshot();
      chunks.length = 0;
      retainedBytes = 0;
      return result;
    },
  };
})();
