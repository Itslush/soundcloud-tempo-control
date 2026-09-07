type StretchNode = AudioWorkletNode & {
  configure(options: object): Promise<void>;
  schedule(options: object): Promise<void>;
  latency(): Promise<number>;
};
type Engine = {
  createStretchNode(
    context: AudioContext,
    options: object,
  ): Promise<StretchNode>;
};
export type Track = {
  title: string;
  artist: string;
  permalink: string;
  duration: number;
  stream: string;
  format: string;
  preview: boolean;
};

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Audio processor timed out.')),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export class AudioPreview {
  readonly audio = new Audio();
  private context?: AudioContext;
  private source?: MediaElementAudioSourceNode;
  private input?: GainNode;
  private dry?: GainNode;
  private wet?: GainNode;
  private node?: StretchNode;
  private hls?: import('hls.js').default;
  private localUrl = '';
  private epoch = 0;
  private loading = false;
  private connected = false;
  private needsReset = true;
  private disposed = false;
  private applied = NaN;
  private pending = false;
  private stopping?: Promise<void>;
  private latency = 0;
  private rate = 1;
  private preserve = false;
  private failed = false;
  private loadId = 0;
  private resolveRequest?: AbortController;
  private readyRequest?: AbortController;
  readonly onStatus: (message: string) => void;
  readonly onFailure: (message: string) => void;
  private readonly processorError = () => this.useBrowser();

  constructor(
    onStatus: (message: string) => void,
    onFailure: (message: string) => void,
  ) {
    this.onStatus = onStatus;
    this.onFailure = onFailure;
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'metadata';
    this.audio.volume = 0.15;
    this.audio.hidden = true;
    document.querySelector('.timeline-demo')?.append(this.audio);
    for (const name of ['pause', 'seeking', 'emptied', 'ended'])
      this.audio.addEventListener(name, () => this.reset());
    this.audio.addEventListener('playing', () =>
      this.apply(this.rate, this.preserve),
    );
    this.audio.addEventListener('seeked', () =>
      this.apply(this.rate, this.preserve),
    );
    this.audio.addEventListener('error', () => {
      if (this.audio.error)
        this.fail('Audio could not be loaded. Retry or choose another track.');
    });
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) return this.dispose();
      this.audio.pause();
      void this.context?.suspend();
    });
  }

  private reset() {
    this.epoch++;
    const node = this.node;
    if (node && this.connected) {
      node.disconnect();
      try {
        this.input?.disconnect(node);
      } catch {}
      if (!this.failed && !this.disposed && !this.stopping)
        this.stopping = deadline(node.schedule({ active: false }))
          .catch(() => this.useBrowser())
          .finally(() => {
            this.stopping = undefined;
          });
    }
    this.connected = false;
    this.needsReset = true;
    this.pending = false;
    this.applied = NaN;
    if (this.dry)
      this.dry.gain.value =
        this.preserve && this.node && !this.failed ? 0 : 0.5;
    if (this.input) {
      this.input.gain.cancelScheduledValues(this.context!.currentTime);
      this.input.gain.value = 0;
    }
    if (this.wet) {
      this.wet.gain.cancelScheduledValues(this.context!.currentTime);
      this.wet.gain.value = 0;
    }
    this.audio.preservesPitch = this.preserve;
  }

  private release(node: StretchNode) {
    node.removeEventListener('processorerror', this.processorError);
    node.disconnect();
    node.port.onmessage = null;
    node.port.close();
    if (this.node === node) this.node = undefined;
  }

  private useBrowser() {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.reset();
    if (this.node) this.release(this.node);
    if (this.preserve) this.onStatus('Using browser key preservation.');
  }

  private async graph() {
    if (this.context) return;
    const context = new AudioContext();
    this.context = context;
    this.source = context.createMediaElementSource(this.audio);
    this.input = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.dry.gain.value = 0.5;
    this.wet.gain.value = 0;
    this.input.gain.value = 0;
    this.source.connect(this.input);
    this.source.connect(this.dry).connect(context.destination);
    this.wet.connect(context.destination);
  }

  private async prepare() {
    if (this.loading || this.failed || this.disposed || !this.context) return;
    this.loading = true;
    const epoch = this.epoch;
    try {
      if (!this.node) {
        const url = `${import.meta.env.BASE_URL}audio/engine.js`;
        const engine: Engine = await deadline(import(url));
        if (this.disposed || this.failed) return;
        const pending = engine.createStretchNode(this.context, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        pending.then(
          (node) => {
            if (this.disposed || this.failed) return this.release(node);
            this.node = node;
            node.addEventListener('processorerror', this.processorError);
          },
          () => {},
        );
        await deadline(pending);
      }
      if (epoch !== this.epoch) return;
      if (this.stopping) await this.stopping;
      if (epoch !== this.epoch || this.disposed || this.failed) return;
      const node = this.node!;
      const sampleRate = this.context.sampleRate;
      await deadline(
        node.configure({
          blockMs: (Math.floor(sampleRate * 0.12) / sampleRate) * 1000,
          intervalMs: (Math.floor(sampleRate * 0.03) / sampleRate) * 1000,
          splitComputation: false,
        }),
      );
      this.latency = await deadline(node.latency());
      if (!Number.isFinite(this.latency) || this.latency < 0)
        throw new Error('Audio processor returned invalid latency.');
      if (epoch !== this.epoch || this.disposed || this.failed) return;
      this.input!.connect(node);
      this.connected = true;
      node.connect(this.wet!);
      this.needsReset = false;
    } catch {
      this.useBrowser();
    } finally {
      this.loading = false;
      if (
        !this.disposed &&
        !this.failed &&
        this.preserve &&
        !this.audio.paused &&
        !this.audio.seeking
      )
        this.apply(this.rate, this.preserve);
    }
  }

  apply(rate: number, preserve: boolean) {
    const changedMode = this.preserve !== preserve;
    this.rate = rate;
    this.preserve = preserve;
    this.audio.playbackRate = rate;
    if (!preserve) {
      if (this.connected || changedMode) this.reset();
      this.audio.preservesPitch = false;
      return;
    }
    this.audio.preservesPitch =
      !this.connected || this.loading || !Number.isFinite(this.applied);
    if (this.audio.paused || this.audio.seeking) return;
    if (this.needsReset || !this.node) {
      void this.prepare();
      return;
    }
    if (this.loading || this.pending || this.applied === rate) return;
    this.pending = true;
    const epoch = this.epoch;
    deadline(
      this.node.schedule({ active: true, semitones: -12 * Math.log2(rate) }),
    )
      .then(() => {
        if (epoch !== this.epoch) return;
        this.pending = false;
        if (this.rate !== rate) return this.apply(this.rate, this.preserve);
        const starting = !Number.isFinite(this.applied);
        this.applied = rate;
        this.audio.preservesPitch = false;
        this.dry!.gain.value = 0;
        if (starting) {
          const now = this.context!.currentTime;
          const input = this.input!.gain;
          input.cancelScheduledValues(now);
          input.setValueAtTime(0, now);
          input.setValueAtTime(1, now + this.latency);
          const gain = this.wet!.gain;
          gain.cancelScheduledValues(now);
          gain.setValueAtTime(0, now);
          gain.setValueAtTime(0, now + this.latency * 2);
          gain.linearRampToValueAtTime(0.5, now + this.latency * 2 + 0.01);
        }
      })
      .catch(() => {
        if (epoch === this.epoch) this.useBrowser();
      });
  }

  async unlock() {
    await this.graph();
    await this.context!.resume();
  }

  async play() {
    await this.unlock();
    await this.audio.play();
    this.apply(this.rate, this.preserve);
  }

  private clear() {
    this.resolveRequest?.abort();
    this.readyRequest?.abort();
    this.audio.pause();
    this.reset();
    this.hls?.destroy();
    this.hls = undefined;
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.localUrl) URL.revokeObjectURL(this.localUrl);
    this.localUrl = '';
  }

  private fail(message: string) {
    this.readyRequest?.abort(new Error(message));
    this.audio.pause();
    this.hls?.destroy();
    this.hls = undefined;
    this.onFailure(message);
  }

  private ready() {
    this.readyRequest = new AbortController();
    const signal = this.readyRequest.signal;
    return new Promise<number>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.audio.removeEventListener('loadedmetadata', check);
        this.audio.removeEventListener('durationchange', check);
        signal.removeEventListener('abort', abort);
      };
      const check = () => {
        if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0)
          return;
        cleanup();
        resolve(this.audio.duration);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Audio took too long to load. Retry the track.'));
      }, 30000);
      this.audio.addEventListener('loadedmetadata', check);
      this.audio.addEventListener('durationchange', check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  async loadFile(file: File | Blob) {
    this.loadId++;
    this.clear();
    if (!file.size || file.size > 512 * 1024 * 1024)
      throw new Error('Choose an audio file smaller than 512 MB.');
    this.localUrl = URL.createObjectURL(file);
    this.audio.src = this.localUrl;
    return this.ready();
  }

  async loadLink(url: string): Promise<Track | null> {
    const id = ++this.loadId;
    this.clear();
    this.resolveRequest = new AbortController();
    let response: Response;
    try {
      response = await fetch(
        `${import.meta.env.BASE_URL}api/resolve?url=${encodeURIComponent(url)}`,
        {
          signal: AbortSignal.any([
            this.resolveRequest.signal,
            AbortSignal.timeout(45000),
          ]),
        },
      );
    } catch (error) {
      if (id !== this.loadId) return null;
      if ((error as Error).name === 'TimeoutError')
        throw new Error('Track lookup timed out. Retry the track.');
      throw new Error('Could not connect. Check your connection and retry.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        typeof data?.error === 'string'
          ? data.error
          : 'Track could not be loaded. Retry in a moment.',
      );
    if (!data || typeof data.stream !== 'string')
      throw new Error('Track could not be loaded. Retry in a moment.');
    if (id !== this.loadId) return null;
    if (data.format === 'hls') {
      const { default: Hls } = await import('hls.js');
      if (id !== this.loadId) return null;
      if (!Hls.isSupported()) {
        if (!this.audio.canPlayType('application/vnd.apple.mpegurl'))
          throw new Error(
            'This browser does not support this audio stream. Try an audio file.',
          );
        this.audio.src = data.stream;
        await this.ready();
        return id === this.loadId ? data : null;
      }
      this.hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 10,
      });
      this.hls.on(Hls.Events.ERROR, (_, event) => {
        if (event.fatal && id === this.loadId)
          this.fail('Stream interrupted. Retry the track.');
      });
      this.hls.loadSource(data.stream);
      this.hls.attachMedia(this.audio);
    } else this.audio.src = data.stream;
    await this.ready();
    return id === this.loadId ? data : null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadId++;
    this.clear();
    if (this.node) this.release(this.node);
    void this.context?.close();
  }
}

export function sampleAudio() {
  const rate = 24000;
  const length = rate * 24;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0)),
    );
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  const notes = [
    220, 261.6256, 329.6276, 293.6648, 220, 391.9954, 329.6276, 261.6256,
  ];
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const beat = t % 0.5;
    const envelope = Math.min(1, beat / 0.02) * Math.exp(-beat * 6);
    const f = notes[Math.floor(t / 0.5) % notes.length];
    const melody =
      Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t);
    const bass = Math.sin(2 * Math.PI * 110 * t) * 0.22;
    const fade = Math.min(1, t / 0.1, (24 - t) / 0.2);
    view.setInt16(44 + i * 2, (melody * envelope + bass) * fade * 9000, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
