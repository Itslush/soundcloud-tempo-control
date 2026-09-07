const DEFAULT_LIMITS = Object.freeze({
  encodedBytes: 16 * 1024 * 1024,
  resourceBytes: 4 * 1024 * 1024,
  pcmBytes: 2 * 1024 * 1024,
  resourceCount: 64,
  networkTimeoutMs: 8000,
  operationTimeoutMs: 8000,
  decoderQueue: 2,
  outputSamples: 8,
  packetsPerRead: 4096,
  channels: 2,
  sampleRate: 192000,
  framesPerSample: 32768,
});

const AAC_PREROLL_PACKETS = 4;
const MAX_PREROLL_SECONDS = 1;

function failure(message, name = 'Error') {
  return Object.assign(new Error(message), { name });
}

function abortError() {
  return failure('PCM source operation cancelled.', 'AbortError');
}

function mediaUrl(value, base) {
  const url = new URL(value, base);
  const hostAllowed = ['.sndcdn.com', '.media-streaming.soundcloud.cloud'].some(
    (suffix) =>
      url.hostname.endsWith(suffix) && url.hostname.length > suffix.length,
  );
  if (
    url.protocol !== 'https:' ||
    !hostAllowed ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw failure('Unsupported media URL.', 'SecurityError');
  return url.href;
}

function configuredLimits(input = {}) {
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key))
      throw new TypeError(`Unknown source limit: ${key}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`Invalid source limit: ${key}`);
  }
  if (
    limits.networkTimeoutMs > 2147483647 ||
    limits.operationTimeoutMs > 2147483647
  )
    throw new TypeError('Source deadlines exceed the timer range.');
  return Object.freeze(limits);
}

function guarded(promise, signal, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || abortError());
    const timer = setTimeout(
      () => finish(reject, failure(timeoutMessage, 'TimeoutError')),
      timeoutMs,
    );
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) abort();
  });
}

function quietCancel(reader) {
  try {
    Promise.resolve(reader?.cancel()).catch(() => {});
  } catch {}
}

class Budget {
  constructor(owner, field, maximum) {
    this.owner = owner;
    this.field = field;
    this.maximum = maximum;
    this.releases = new Set();
  }

  reserve(bytes) {
    const stats = this.owner.counters;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      stats[this.field] + bytes > this.maximum
    )
      throw failure(
        `${this.field === 'heldEncodedBytes' ? 'Encoded resource' : 'PCM output'} budget exceeded.`,
        'QuotaExceededError',
      );
    stats[this.field] += bytes;
    const peak =
      this.field === 'heldEncodedBytes'
        ? 'peakHeldEncodedBytes'
        : 'peakHeldPcmBytes';
    stats[peak] = Math.max(stats[peak], stats[this.field]);
    const release = () => {
      if (!this.releases.delete(release)) return;
      stats[this.field] -= bytes;
    };
    this.releases.add(release);
    return release;
  }

  clear() {
    for (const release of this.releases) release();
  }
}

class SourceTransaction {
  constructor(owner, signal) {
    this.owner = owner;
    this.limits = owner.limits;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.resources = new Map();
    this.readers = new Set();
    this.queue = [];
    this.waiters = new Set();
    this.encoded = new Budget(
      owner,
      'heldEncodedBytes',
      this.limits.encodedBytes,
    );
    this.pcm = new Budget(owner, 'heldPcmBytes', this.limits.pcmBytes);
    this.networkTail = Promise.resolve();
    this.closed = false;
    this.error = null;
    this.lastTimestamp = -Infinity;
    this.callerPacket = null;
    this.externalSignal = signal;
    this.onAbort = () => this.fail(signal.reason || abortError());
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  check() {
    if (this.error) throw this.error;
    if (this.closed || this.owner.disposed) throw abortError();
  }

  async wait(promise) {
    this.check();
    try {
      const result = await guarded(
        promise,
        this.signal,
        this.limits.operationTimeoutMs,
        'PCM source operation timed out.',
      );
      this.check();
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async changed() {
    let notify;
    const change = new Promise((resolve) => {
      notify = resolve;
    });
    this.waiters.add(notify);
    try {
      await this.wait(change);
    } finally {
      this.waiters.delete(notify);
    }
  }

  fail(error) {
    if (!this.error) this.error = error;
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(this.error || abortError());
    this.externalSignal?.removeEventListener('abort', this.onAbort);
    for (const reader of this.readers) quietCancel(reader);
    this.readers.clear();
    if (this.decoder) {
      this.decoder.removeEventListener('dequeue', this.onDequeue);
      try {
        this.decoder.close();
      } catch {}
      this.owner.counters.closedDecoders++;
      this.decoder = null;
    }
    try {
      this.input?.dispose();
    } catch {}
    this.input = null;
    this.sink = null;
    this.packet = null;
    this.resources.clear();
    this.callerPacket?.release();
    this.callerPacket = null;
    for (const packet of this.queue) packet.release();
    this.queue.length = 0;
    this.encoded.clear();
    this.pcm.clear();
    this.owner.counters.decodeQueueSize = 0;
    this.owner.counters.queuedSamples = 0;
    this.wake();
    if (this.owner.active === this) this.owner.active = null;
  }

  resource(path) {
    this.check();
    const url = mediaUrl(path, this.owner.url);
    if (!this.resources.has(url)) {
      if (this.resources.size >= this.limits.resourceCount)
        throw failure('Media resource count exceeded.', 'QuotaExceededError');
      const pending = this.networkTail.then(() => this.fetchResource(url));
      this.networkTail = pending.then(
        () => undefined,
        () => undefined,
      );
      this.resources.set(url, pending);
    }
    return this.resources.get(url).then((bytes) => {
      this.check();
      return new this.owner.library.BufferSource(bytes);
    });
  }

  async fetchResource(url) {
    this.check();
    if (url === this.owner.url && this.owner.manifest) {
      this.encoded.reserve(this.owner.manifest.byteLength);
      return this.owner.manifest.slice();
    }
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(failure('Media resource timed out.', 'TimeoutError')),
      this.limits.networkTimeoutMs,
    );
    const chunks = [];
    let reader;
    let response;
    let total = 0;
    let assembledRelease;
    try {
      const pending = this.owner.fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
      });
      Promise.resolve(pending).then(
        (response) => {
          if (controller.signal.aborted) quietCancel(response.body);
        },
        () => {},
      );
      response = await guarded(
        pending,
        controller.signal,
        this.limits.networkTimeoutMs,
        'Media resource timed out.',
      );
      this.check();
      if (
        response.redirected ||
        (response.url && mediaUrl(response.url) !== url)
      )
        throw failure('Media redirects are not allowed.', 'SecurityError');
      if (response.status !== 200 || !response.body)
        throw failure('Media resource could not be read.');
      const lengthHeader = response.headers.get('content-length');
      const length = lengthHeader === null ? null : Number(lengthHeader);
      if (
        length !== null &&
        (!/^\d+$/.test(lengthHeader) ||
          !Number.isSafeInteger(length) ||
          length > this.limits.resourceBytes)
      )
        throw failure(
          'Media resource exceeds its size limit.',
          'QuotaExceededError',
        );
      reader = response.body.getReader();
      this.readers.add(reader);
      while (true) {
        const { done, value } = await guarded(
          reader.read(),
          controller.signal,
          this.limits.networkTimeoutMs,
          'Media resource timed out.',
        );
        this.check();
        if (done) break;
        if (!(value instanceof Uint8Array))
          throw new TypeError('Invalid media resource chunk.');
        this.owner.counters.deliveredBytes += value.byteLength;
        total += value.byteLength;
        if (total > this.limits.resourceBytes)
          throw failure(
            'Media resource exceeds its size limit.',
            'QuotaExceededError',
          );
        const release = this.encoded.reserve(value.buffer.byteLength);
        chunks.push({ value, release });
      }
      if (!total) throw failure('Empty media resource.');
      assembledRelease = this.encoded.reserve(total);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
        chunk.release();
      }
      chunks.length = 0;
      assembledRelease = null;
      this.owner.counters.fetchedResources++;
      this.owner.retainManifest(url, bytes);
      return bytes;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
      controller.abort();
      for (const chunk of chunks) chunk.release();
      assembledRelease?.();
      if (reader) {
        this.readers.delete(reader);
        quietCancel(reader);
        try {
          reader.releaseLock();
        } catch {}
      } else quietCancel(response?.body);
    }
  }

  async open() {
    this.check();
    const { library } = this.owner;
    const source = new library.CustomPathedSource(this.owner.url, ({ path }) =>
      this.resource(path),
    );
    this.input = new library.Input({ source, formats: this.owner.formats });
    const track = await this.wait(this.input.getPrimaryAudioTrack());
    if (!track) throw failure('Media resource has no audio track.');
    const config = await this.wait(track.getDecoderConfig());
    if (!config || typeof config.codec !== 'string' || !config.codec)
      throw failure('Audio decoder configuration is unavailable.');
    this.validateFormat(config.sampleRate, config.numberOfChannels);
    const duration = await this.wait(track.getDurationFromMetadata());
    if (duration !== null && (!Number.isFinite(duration) || duration < 0))
      throw failure('Invalid audio duration.');
    return {
      track,
      config,
      metadata: Object.freeze({
        codec: config.codec,
        declaredSampleRate: config.sampleRate,
        declaredChannels: config.numberOfChannels,
        duration,
      }),
    };
  }

  validateFormat(sampleRate, channels) {
    if (
      !Number.isSafeInteger(sampleRate) ||
      sampleRate <= 0 ||
      sampleRate > this.limits.sampleRate ||
      !Number.isSafeInteger(channels) ||
      channels <= 0 ||
      channels > this.limits.channels
    )
      throw failure('Unsupported audio sample format.');
  }

  output(sample, start, end) {
    this.owner.counters.receivedSamples++;
    let release;
    try {
      if (this.closed) {
        this.owner.counters.staleSamples++;
        return;
      }
      const {
        timestamp: microseconds,
        sampleRate,
        numberOfChannels,
        numberOfFrames,
      } = sample;
      this.validateFormat(sampleRate, numberOfChannels);
      if (
        !Number.isSafeInteger(microseconds) ||
        !Number.isSafeInteger(numberOfFrames) ||
        numberOfFrames <= 0 ||
        numberOfFrames > this.limits.framesPerSample
      )
        throw failure('Invalid decoded audio sample.');
      const timestamp = microseconds / 1000000;
      if (timestamp <= this.lastTimestamp)
        throw failure('Audio timestamps did not advance.');
      this.lastTimestamp = timestamp;
      if (
        this.outputFormat &&
        (this.outputFormat.sampleRate !== sampleRate ||
          this.outputFormat.channels !== numberOfChannels)
      )
        throw failure('Audio sample format changed during the read.');
      this.outputFormat = { sampleRate, channels: numberOfChannels };
      const sampleEnd = timestamp + numberOfFrames / sampleRate;
      const tolerance = Math.max(1 / sampleRate, 0.000001);
      if (
        this.previousSampleEnd !== undefined &&
        Math.abs(timestamp - this.previousSampleEnd) > tolerance
      )
        throw failure('Decoded audio is not contiguous.', 'DataError');
      this.previousSampleEnd = sampleEnd;
      if (timestamp >= end || sampleEnd <= start) return;
      if (this.coveredUntil === undefined && timestamp > start + tolerance)
        throw failure(
          'Decoded audio does not cover the requested start.',
          'DataError',
        );
      this.coveredUntil = sampleEnd;
      this.coverageTolerance = tolerance;
      if (this.queue.length >= this.limits.outputSamples)
        throw failure('Decoded audio queue exceeded.', 'QuotaExceededError');
      const bytes =
        numberOfFrames * numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      release = this.pcm.reserve(bytes);
      const channels = [];
      for (let planeIndex = 0; planeIndex < numberOfChannels; planeIndex++) {
        const plane = new Float32Array(numberOfFrames);
        sample.copyTo(plane, { planeIndex, format: 'f32-planar' });
        if (!plane.every(Number.isFinite))
          throw failure('Decoded audio contains non-finite samples.');
        channels.push(plane);
      }
      let released = false;
      const free = release;
      const packet = Object.freeze({
        timestamp,
        sampleRate,
        channels,
        get released() {
          return released;
        },
        release() {
          if (released) return;
          released = true;
          channels.length = 0;
          free();
        },
      });
      this.queue.push(packet);
      release = null;
      this.owner.counters.queuedSamples = this.queue.length;
      this.owner.counters.peakQueuedSamples = Math.max(
        this.owner.counters.peakQueuedSamples,
        this.queue.length,
      );
    } catch (error) {
      release?.();
      this.owner.counters.rejectedSamples++;
      this.fail(error);
    } finally {
      try {
        sample.close();
      } finally {
        this.owner.counters.closedSamples++;
      }
      this.wake();
    }
  }

  async configure(config, start, end) {
    const Decoder = this.owner.Decoder;
    if (typeof Decoder !== 'function')
      throw failure('Audio decoding is unavailable.');
    const supported = await this.wait(Decoder.isConfigSupported(config));
    if (!supported.supported) throw failure('Audio codec is unsupported.');
    this.decoder = new Decoder({
      output: (sample) => this.output(sample, start, end),
      error: (error) => this.fail(error),
    });
    this.owner.counters.openedDecoders++;
    this.onDequeue = () => {
      this.owner.counters.decodeQueueSize = this.decoder?.decodeQueueSize || 0;
      this.wake();
    };
    this.decoder.addEventListener('dequeue', this.onDequeue);
    this.decoder.configure(config);
  }

  async prepare(start, end) {
    const { track, config } = await this.open();
    if (!/^mp4a\.40\.0?2$/.test(config.codec))
      throw failure(
        'Only AAC-LC seek decoding is available.',
        'NotSupportedError',
      );
    const resolution = await this.wait(track.getTimeResolution());
    if (!Number.isFinite(resolution) || resolution <= 0)
      throw failure('Invalid audio time resolution.');
    this.packetTick = Math.max(1 / resolution, 0.000001);
    await this.configure(config, start, end);
    this.sink = new this.owner.library.EncodedPacketSink(track);
  }

  async firstPacket(start, options) {
    let packet = await this.wait(this.sink.getKeyPacket(start, options));
    if (!packet) return this.wait(this.sink.getFirstKeyPacket(options));
    const targetTimestamp = packet.timestamp;
    if (!Number.isFinite(targetTimestamp))
      throw failure('Invalid encoded audio timestamps.');
    for (let count = 0; count < AAC_PREROLL_PACKETS; count++) {
      const previous = await this.wait(
        this.sink.getPacket(packet.timestamp - this.packetTick, options),
      );
      if (!previous) break;
      if (
        !Number.isFinite(previous.timestamp) ||
        previous.timestamp >= packet.timestamp ||
        targetTimestamp - previous.timestamp > MAX_PREROLL_SECONDS
      )
        throw failure(
          'AAC preroll exceeds the supported seek window.',
          'DataError',
        );
      packet = previous;
    }
    return packet;
  }

  validateCoverage(end) {
    if (
      this.coveredUntil === undefined ||
      this.coveredUntil + this.coverageTolerance < end
    )
      throw failure(
        'Decoded audio does not cover the requested interval.',
        'DataError',
      );
  }

  finish(start, end, allowEndOfStream) {
    if (!allowEndOfStream) {
      this.validateCoverage(end);
      return;
    }
    if (this.packet) {
      this.validateCoverage(end);
      return Object.freeze({
        endOfStream: false,
        sampleRate: this.outputFormat.sampleRate,
      });
    }
    if (!this.outputFormat || !Number.isFinite(this.previousSampleEnd))
      throw failure('Decoded audio has no verified end.', 'DataError');
    if (start < this.previousSampleEnd)
      this.validateCoverage(Math.min(end, this.previousSampleEnd));
    return Object.freeze({
      endOfStream: true,
      sampleRate: this.outputFormat.sampleRate,
      endTimestamp: this.previousSampleEnd,
    });
  }

  async *samples(start, end, allowEndOfStream) {
    await this.prepare(start, end);
    const options = { verifyKeyPackets: true, skipLiveWait: true };
    this.packet = await this.firstPacket(start, options);
    let previousTimestamp = -Infinity;
    let packetCount = 0;
    let flushed = false;
    while (true) {
      this.check();
      if (this.callerPacket && !this.callerPacket.released)
        throw failure(
          'Release the previous PCM packet before reading another.',
          'InvalidStateError',
        );
      this.callerPacket = null;
      if (this.queue.length) {
        this.callerPacket = this.queue.shift();
        this.owner.counters.queuedSamples = this.queue.length;
        yield this.callerPacket;
        continue;
      }
      if (!this.packet || this.packet.timestamp >= end) {
        if (flushed) {
          return this.finish(start, end, allowEndOfStream);
        }
        await this.wait(this.decoder.flush());
        flushed = true;
        continue;
      }
      if (this.decoder.decodeQueueSize >= this.limits.decoderQueue) {
        await this.changed();
        continue;
      }
      if (++packetCount > this.limits.packetsPerRead)
        throw failure(
          'Encoded audio packet count exceeded.',
          'QuotaExceededError',
        );
      if (
        !Number.isFinite(this.packet.timestamp) ||
        this.packet.timestamp <= previousTimestamp ||
        !Number.isFinite(this.packet.duration) ||
        this.packet.duration <= 0
      )
        throw failure('Invalid encoded audio timestamps.');
      previousTimestamp = this.packet.timestamp;
      this.decoder.decode(this.packet.toEncodedAudioChunk());
      this.owner.counters.decodeQueueSize = this.decoder?.decodeQueueSize || 0;
      this.owner.counters.peakDecodeQueueSize = Math.max(
        this.owner.counters.peakDecodeQueueSize,
        this.owner.counters.decodeQueueSize,
      );
      this.check();
      this.packet = await this.wait(
        this.sink.getNextPacket(this.packet, options),
      );
    }
  }
}

class PcmSource {
  constructor({
    library,
    url,
    limits,
    fetch: fetchFn = globalThis.fetch?.bind(globalThis),
    AudioDecoder: Decoder = globalThis.AudioDecoder,
    formats,
  }) {
    for (const key of [
      'Input',
      'CustomPathedSource',
      'BufferSource',
      'EncodedPacketSink',
    ]) {
      if (typeof library?.[key] !== 'function')
        throw new TypeError(`Missing media library API: ${key}`);
    }
    if (typeof fetchFn !== 'function')
      throw new TypeError('A fetch implementation is required.');
    this.formats = formats || library.HLS_FORMATS;
    if (!Array.isArray(this.formats) || !this.formats.length)
      throw new TypeError('Input formats are required.');
    this.library = library;
    this.url = mediaUrl(url);
    this.limits = configuredLimits(limits);
    this.fetch = fetchFn;
    this.Decoder = Decoder;
    this.disposed = false;
    this.active = null;
    this.metadata = null;
    this.counters = {
      heldEncodedBytes: 0,
      peakHeldEncodedBytes: 0,
      heldPcmBytes: 0,
      peakHeldPcmBytes: 0,
      decodeQueueSize: 0,
      peakDecodeQueueSize: 0,
      queuedSamples: 0,
      peakQueuedSamples: 0,
      fetchedResources: 0,
      deliveredBytes: 0,
      openedDecoders: 0,
      closedDecoders: 0,
      receivedSamples: 0,
      closedSamples: 0,
      rejectedSamples: 0,
      staleSamples: 0,
    };
    this.manifest = null;
    this.manifestBudget = new Budget(
      this,
      'heldEncodedBytes',
      this.limits.encodedBytes,
    );
  }

  retainManifest(url, bytes) {
    if (
      this.manifest ||
      url !== this.url ||
      bytes.byteLength > 262144 ||
      this.counters.heldEncodedBytes + bytes.byteLength >
        this.limits.encodedBytes
    )
      return;
    const text = new TextDecoder().decode(bytes);
    if (!/^#EXTM3U(?:\r?\n)/.test(text) || !/^#EXT-X-ENDLIST\s*$/m.test(text))
      return;
    this.manifestBudget.reserve(bytes.byteLength);
    this.manifest = bytes.slice();
  }

  begin(signal) {
    if (this.disposed || signal?.aborted) throw signal?.reason || abortError();
    if (this.active)
      throw failure(
        'A PCM source read is already active.',
        'InvalidStateError',
      );
    const transaction = new SourceTransaction(this, signal);
    this.active = transaction;
    return transaction;
  }

  async info({ signal } = {}) {
    if (this.disposed || signal?.aborted) throw signal?.reason || abortError();
    if (this.metadata) return this.metadata;
    const transaction = this.begin(signal);
    try {
      const { metadata } = await transaction.open();
      this.metadata = metadata;
      return metadata;
    } finally {
      transaction.close();
    }
  }

  async *read(start, end, { signal, allowEndOfStream = false } = {}) {
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isFinite(end) ||
      end <= start
    )
      throw new TypeError('A finite positive audio interval is required.');
    if (typeof allowEndOfStream !== 'boolean')
      throw new TypeError('allowEndOfStream must be a boolean.');
    const transaction = this.begin(signal);
    try {
      return yield* transaction.samples(start, end, allowEndOfStream);
    } finally {
      transaction.close();
    }
  }

  stats() {
    return Object.freeze({
      ...this.counters,
      activeTransactions: this.active ? 1 : 0,
      retainedManifestBytes: this.manifest?.byteLength ?? 0,
      disposed: this.disposed,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.close();
    this.metadata = null;
    this.manifest = null;
    this.manifestBudget.clear();
  }
}

export function createPcmSource(options) {
  const source = new PcmSource(options);
  return Object.freeze({
    info: (options) => source.info(options),
    read: (start, end, options) => source.read(start, end, options),
    dispose: () => source.dispose(),
    stats: () => source.stats(),
  });
}
