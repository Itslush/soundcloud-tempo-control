const BLOCK_BYTES = 16384;
const DEFAULT_LIMITS = Object.freeze({
  playlists: 8,
  playlistCharacters: 262144,
  segments: 512,
  urlCharacters: 4096,
  playlistUrlCharacters: 1024 * 1024,
  resources: 64,
  sources: 8,
  media: 8,
  parsers: 16,
  boxBytes: 4 * 1024 * 1024,
  pendingHashBytes: 1024 * 1024,
  digestBytes: 256 * 1024,
});

function mediaUrl(value, base, maximum) {
  if (typeof value !== 'string' || value.length > maximum) return null;
  try {
    const url = new URL(value, base);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !(
        url.hostname.endsWith('.sndcdn.com') ||
        url.hostname.endsWith('.media-streaming.soundcloud.cloud')
      ) ||
      url.href.length > maximum
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function bytesOf(value) {
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('A byte buffer is required.');
}

function hex(value) {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

class PayloadHash {
  constructor(owner, length, publish) {
    this.owner = owner;
    this.length = length;
    this.publish = publish;
    this.remaining = length;
    this.used = 0;
    this.blocks = [];
    this.metadataBytes = 0;
    this.scratch = new Uint8Array(BLOCK_BYTES);
    owner.scratchBytes += BLOCK_BYTES;
    owner.account();
  }

  write(bytes) {
    if (this.closed) return;
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(
        bytes.length - offset,
        BLOCK_BYTES - this.used,
        this.remaining,
      );
      if (!count) throw new Error('Invalid media payload length.');
      this.scratch.set(bytes.subarray(offset, offset + count), this.used);
      this.used += count;
      this.remaining -= count;
      offset += count;
      if (this.used === BLOCK_BYTES || !this.remaining) {
        this.owner.reserveDigest(32);
        this.metadataBytes += 32;
        this.blocks.push(this.owner.hash(this.scratch.subarray(0, this.used)));
        this.used = 0;
      }
    }
    if (!this.remaining) this.finish();
  }

  finish() {
    this.closed = true;
    this.releaseScratch();
    const work = Promise.all(this.blocks)
      .then(async (hashes) => {
        if (this.cancelled || this.owner.disposed) return;
        const length = hashes.length * 32;
        this.owner.reserveDigest(length);
        this.metadataBytes += length;
        const combined = new Uint8Array(length);
        hashes.forEach((hash, index) =>
          combined.set(new Uint8Array(hash), index * 32),
        );
        const result = await this.owner.hash(combined);
        if (!this.cancelled && !this.owner.disposed)
          this.publish(`${this.length}:${hex(result)}`);
      })
      .catch(() => {
        this.owner.failures++;
      })
      .finally(() => {
        this.blocks.length = 0;
        this.owner.digestBytes -= this.metadataBytes;
        this.metadataBytes = 0;
      });
    this.owner.join(work);
  }

  releaseScratch() {
    if (!this.scratch) return;
    this.scratch = null;
    this.owner.scratchBytes -= BLOCK_BYTES;
  }

  abort() {
    this.cancelled = true;
    this.releaseScratch();
    if (this.closed) return;
    this.closed = true;
    const work = Promise.allSettled(this.blocks).then(() => {
      this.blocks.length = 0;
      this.owner.digestBytes -= this.metadataBytes;
      this.metadataBytes = 0;
    });
    this.owner.join(work);
  }
}

class BoxParser {
  constructor(owner, onPayload, onFailure) {
    this.owner = owner;
    this.onPayload = onPayload;
    this.onFailure = onFailure;
    this.header = new Uint8Array(16);
    this.headerLength = 0;
    this.headerNeeded = 8;
    this.remaining = 0;
    this.payload = null;
    this.boxes = 0;
    if (owner.parsers.size >= owner.limits.parsers)
      throw new Error('Media parser limit exceeded.');
    owner.parsers.add(this);
  }

  write(value) {
    if (this.closed || this.owner.disposed) return;
    try {
      const bytes = bytesOf(value);
      if (bytes.length > this.owner.limits.boxBytes)
        throw new Error('Media chunk limit exceeded.');
      let offset = 0;
      while (offset < bytes.length) {
        if (this.remaining) {
          const count = Math.min(this.remaining, bytes.length - offset);
          this.payload?.write(bytes.subarray(offset, offset + count));
          this.remaining -= count;
          offset += count;
          if (!this.remaining) this.payload = null;
          continue;
        }
        const count = Math.min(
          this.headerNeeded - this.headerLength,
          bytes.length - offset,
        );
        this.header.set(
          bytes.subarray(offset, offset + count),
          this.headerLength,
        );
        this.headerLength += count;
        offset += count;
        if (this.headerLength < this.headerNeeded) continue;
        const view = new DataView(this.header.buffer);
        let length = view.getUint32(0);
        if (length === 1 && this.headerNeeded === 8) {
          this.headerNeeded = 16;
          continue;
        }
        if (length === 1) length = Number(view.getBigUint64(8));
        if (
          !Number.isSafeInteger(length) ||
          length < this.headerNeeded ||
          length > this.owner.limits.boxBytes ||
          ++this.boxes > 4096
        )
          throw new Error('Unsupported media box.');
        const type = String.fromCharCode(...this.header.subarray(4, 8));
        this.remaining = length - this.headerNeeded;
        if (type === 'mdat' && this.remaining) {
          const publish = this.onPayload();
          this.payload = new PayloadHash(this.owner, this.remaining, publish);
        }
        this.headerLength = 0;
        this.headerNeeded = 8;
      }
    } catch {
      this.owner.failures++;
      this.abort();
      this.onFailure();
    }
  }

  close() {
    if (this.closed) return;
    if (this.remaining || this.headerLength) {
      this.owner.failures++;
      this.onFailure();
    }
    this.abort();
  }

  abort() {
    if (this.closed) return;
    this.closed = true;
    this.payload?.abort();
    this.payload = null;
    this.owner.parsers.delete(this);
  }
}

class SourceBinding {
  constructor({
    global = globalThis,
    limits = {},
    onChange = () => {},
    digest,
  } = {}) {
    this.global = global;
    this.limits = { ...DEFAULT_LIMITS };
    for (const [key, value] of Object.entries(limits)) {
      if (
        !Object.hasOwn(DEFAULT_LIMITS, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > DEFAULT_LIMITS[key]
      )
        throw new TypeError('Invalid source binding limit.');
      this.limits[key] = value;
    }
    this.digest =
      digest || global.crypto?.subtle?.digest.bind(global.crypto.subtle);
    if (typeof this.digest !== 'function' || typeof onChange !== 'function')
      throw new TypeError(
        'Source binding requires SHA-256 and a change callback.',
      );
    this.onChange = onChange;
    this.WeakRef = global.WeakRef ?? globalThis.WeakRef;
    if (typeof this.WeakRef !== 'function')
      throw new TypeError('Source binding requires weak references.');
    this.playlists = new Map();
    this.playlistVersions = new Map();
    this.nextPlaylistVersion = 0;
    this.resources = new Map();
    this.sources = new WeakMap();
    this.sourceStates = new Set();
    this.sourceBuffers = new WeakMap();
    this.urls = new Map();
    this.media = new WeakMap();
    this.mediaRefs = new Set();
    this.parsers = new Set();
    this.jobs = new Set();
    this.restorers = [];
    this.pendingHashBytes = 0;
    this.peakPendingHashBytes = 0;
    this.scratchBytes = 0;
    this.peakScratchBytes = 0;
    this.digestBytes = 0;
    this.peakDigestBytes = 0;
    this.failures = 0;
    this.nextSource = 0;
    this.disposed = false;
  }

  account() {
    this.peakPendingHashBytes = Math.max(
      this.peakPendingHashBytes,
      this.pendingHashBytes,
    );
    this.peakScratchBytes = Math.max(this.peakScratchBytes, this.scratchBytes);
    this.peakDigestBytes = Math.max(this.peakDigestBytes, this.digestBytes);
  }

  reserveDigest(bytes) {
    if (this.digestBytes + bytes > this.limits.digestBytes)
      throw new Error('Digest metadata limit exceeded.');
    this.digestBytes += bytes;
    this.account();
  }

  join(promise) {
    this.jobs.add(promise);
    promise.finally(() => this.jobs.delete(promise)).catch(() => {});
    return promise;
  }

  hash(bytes) {
    const length = bytes.byteLength;
    if (this.pendingHashBytes + length > this.limits.pendingHashBytes)
      throw new Error('Pending hash input limit exceeded.');
    this.pendingHashBytes += length;
    this.account();
    let promise;
    try {
      promise = this.digest('SHA-256', bytes);
    } catch (cause) {
      this.pendingHashBytes -= length;
      throw cause;
    }
    return this.join(
      Promise.resolve(promise).finally(() => {
        this.pendingHashBytes -= length;
      }),
    );
  }

  playlist(url, text) {
    if (this.disposed) return false;
    url = mediaUrl(url, undefined, this.limits.urlCharacters);
    if (
      !url ||
      typeof text !== 'string' ||
      text.length > this.limits.playlistCharacters ||
      !text.startsWith('#EXTM3U') ||
      !/^#EXT-X-ENDLIST\s*$/m.test(text) ||
      /^#EXT-X-(?:KEY|STREAM-INF|BYTERANGE):/m.test(text)
    )
      return false;
    const segments = new Set();
    let characters = url.length;
    let expectedSegment = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF:')) expectedSegment = true;
      if (!line.trim() || line.startsWith('#')) continue;
      if (!expectedSegment) return false;
      const child = mediaUrl(line.trim(), url, this.limits.urlCharacters);
      if (!child || segments.size >= this.limits.segments) return false;
      if (!segments.has(child)) characters += child.length;
      if (characters > this.limits.playlistUrlCharacters) return false;
      segments.add(child);
      expectedSegment = false;
    }
    if (!segments.size || expectedSegment) return false;
    const previous = this.playlists.get(url);
    if (
      previous &&
      previous.size === segments.size &&
      [...previous].every((segment) => segments.has(segment))
    )
      return true;
    const previousCharacters = previous
      ? url.length +
        [...previous].reduce((total, value) => total + value.length, 0)
      : 0;
    if (
      this.urlCharacterCount() - previousCharacters + characters >
      this.limits.playlistUrlCharacters
    )
      return false;
    if (
      !this.playlists.has(url) &&
      this.playlists.size >= this.limits.playlists
    ) {
      const active = new Set(
        this.mediaEntries().map(([media]) => this.resolve(media).playlistUrl),
      );
      const oldest = [...this.playlists.keys()].find(
        (candidate) => !active.has(candidate),
      );
      if (!oldest) return false;
      this.playlists.delete(oldest);
      this.playlistVersions.delete(oldest);
    }
    this.playlists.set(url, segments);
    this.playlistVersions.set(url, ++this.nextPlaylistVersion);
    for (const resource of this.resources.keys())
      if (!this.knownResource(resource)) this.resources.delete(resource);
    this.notify();
    return true;
  }

  knownResource(url) {
    return [...this.playlists.values()].some((segments) => segments.has(url));
  }

  urlCharacterCount() {
    let total = 0;
    for (const [url, segments] of this.playlists) {
      total += url.length;
      for (const segment of segments) total += segment.length;
    }
    return total;
  }

  response(url) {
    if (this.disposed) return null;
    url = mediaUrl(url, undefined, this.limits.urlCharacters);
    if (!url || !this.knownResource(url)) return null;
    let active = true;
    let complete = false;
    let pendingKey;
    let byteCount = 0;
    const publish = () => {
      if (
        !active ||
        !complete ||
        !pendingKey ||
        this.disposed ||
        !this.knownResource(url)
      )
        return;
      if (
        !this.resources.has(url) &&
        this.resources.size >= this.limits.resources
      )
        this.resources.delete(this.resources.keys().next().value);
      this.resources.set(url, pendingKey);
      this.notify();
    };
    const parser = new BoxParser(
      this,
      () => (key) => {
        pendingKey = key;
        publish();
      },
      () => {
        active = false;
        this.resources.delete(url);
        this.notify();
      },
    );
    return Object.freeze({
      write: (value) => {
        byteCount += value?.byteLength || 0;
        if (byteCount > this.limits.boxBytes) {
          active = false;
          parser.abort();
          this.failures++;
          return;
        }
        parser.write(value);
      },
      close: () => {
        parser.close();
        complete = true;
        publish();
      },
      abort: () => {
        if (complete) return;
        active = false;
        parser.abort();
      },
    });
  }

  objectUrl(url, mediaSource) {
    if (
      this.disposed ||
      typeof url !== 'string' ||
      !url.startsWith('blob:') ||
      url.length > this.limits.urlCharacters
    )
      return;
    let state = this.sources.get(mediaSource);
    if (!state) {
      if (this.sourceStates.size >= this.limits.sources) return;
      state = {
        id: ++this.nextSource,
        serial: 0,
        proof: null,
        buffers: 0,
        closed: false,
      };
      this.sources.set(mediaSource, state);
      this.sourceStates.add(state);
    }
    if (this.urls.size >= this.limits.sources * 2 && !this.urls.has(url))
      return;
    this.urls.set(url, state);
  }

  sourceBuffer(mediaSource, sourceBuffer, mime) {
    const state = this.sources.get(mediaSource);
    if (!state || this.disposed) return;
    state.buffers++;
    if (
      state.buffers !== 1 ||
      !/^audio\/mp4\s*;\s*codecs\s*=\s*"?mp4a\.40\.2"?\s*$/i.test(mime)
    ) {
      state.closed = true;
      state.proof = null;
      state.parser?.abort();
      this.notify();
      return;
    }
    const parser = new BoxParser(
      this,
      () => {
        const serial = ++state.serial;
        state.proof = null;
        this.notify();
        return (key) => {
          if (state.closed || state.serial !== serial || this.disposed) return;
          state.proof = { serial, key, matches: new Map() };
          this.notify();
        };
      },
      () => {
        state.closed = true;
        state.proof = null;
        this.notify();
      },
    );
    state.parser = parser;
    this.sourceBuffers.set(sourceBuffer, { state, parser });
  }

  append(sourceBuffer, value) {
    const owned = this.sourceBuffers.get(sourceBuffer);
    if (!owned || owned.state.closed || this.disposed) return;
    owned.parser.write(value);
  }

  closeSource(mediaSource) {
    const state = this.sources.get(mediaSource);
    if (!state) return;
    state.closed = true;
    state.proof = null;
    state.parser?.abort();
    this.sourceStates.delete(state);
    for (const [url, source] of this.urls)
      if (source === state) this.urls.delete(url);
    state.removeClose?.();
    this.notify();
  }

  observe(media) {
    if (this.media.has(media)) return this.media.get(media);
    this.mediaEntries();
    if (this.mediaRefs.size >= this.limits.media) return null;
    const state = {
      reference: new this.WeakRef(media),
      generation: 0,
      src: media.currentSrc,
      minimumSerial: 0,
      blockedSource: null,
      lastStatus: '',
    };
    this.media.set(media, state);
    this.mediaRefs.add(state.reference);
    return state;
  }

  mediaEntries() {
    const entries = [];
    for (const reference of this.mediaRefs) {
      const media = reference.deref();
      const state = media && this.media.get(media);
      if (!state || state.reference !== reference) {
        this.mediaRefs.delete(reference);
        continue;
      }
      entries.push([media, state]);
    }
    return entries;
  }

  invalidate(media) {
    if (this.disposed) return;
    const state = this.observe(media);
    if (!state) return;
    state.generation++;
    state.minimumSerial = this.urls.get(media.currentSrc)?.serial || 0;
    state.blockedSource =
      this.urls.get(media.currentSrc)?.id ?? state.blockedSource;
    this.notify();
  }

  resolve(media) {
    if (this.disposed)
      return Object.freeze({ status: 'unbound', reason: 'disposed' });
    const state = this.observe(media);
    if (!state)
      return Object.freeze({ status: 'unavailable', reason: 'media-limit' });
    const src = media.currentSrc;
    if (src !== state.src) {
      state.src = src;
      state.generation++;
      state.minimumSerial = 0;
    }
    const source = this.urls.get(src);
    const base = { generation: state.generation, sourceId: source?.id ?? null };
    if (
      this.disposed ||
      !source ||
      source.closed ||
      source.id === state.blockedSource ||
      !source.proof ||
      source.proof.serial <= state.minimumSerial
    )
      return Object.freeze({ ...base, status: 'unbound' });
    const matches = [];
    for (const [url, version] of source.proof.matches)
      if (this.playlistVersions.get(url) !== version)
        source.proof.matches.delete(url);
    for (const [url, segments] of this.playlists) {
      if (
        source.proof.matches.get(url) === this.playlistVersions.get(url) ||
        [...segments].some(
          (segment) => this.resources.get(segment) === source.proof.key,
        )
      ) {
        matches.push(url);
        source.proof.matches.set(url, this.playlistVersions.get(url));
      }
    }
    if (matches.length !== 1)
      return Object.freeze({
        ...base,
        status: matches.length ? 'ambiguous' : 'unbound',
      });
    return Object.freeze({
      ...base,
      status: 'bound',
      playlistUrl: matches[0],
      proof: 'sha256-mdat-blocks',
      proofSerial: source.proof.serial,
    });
  }

  release(media) {
    const state = this.media.get(media);
    if (state) this.mediaRefs.delete(state.reference);
    this.media.delete(media);
  }

  notify() {
    for (const [media, state] of this.mediaEntries()) {
      if (this.media.get(media) !== state) continue;
      const result = this.resolve(media);
      const signature = JSON.stringify(result);
      if (signature === state.lastStatus) continue;
      state.lastStatus = signature;
      try {
        this.onChange(media, result);
      } catch {
        this.failures++;
      }
    }
  }

  patch(target, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || descriptor.configurable === false)
      throw new Error(`Cannot observe ${key}.`);
    const next = replacement(descriptor);
    Object.defineProperty(target, key, next);
    this.restorers.push(() => {
      const current = Object.getOwnPropertyDescriptor(target, key);
      if (
        current?.value === next.value &&
        current?.get === next.get &&
        current?.set === next.set
      )
        Object.defineProperty(target, key, descriptor);
    });
  }

  install() {
    if (this.installed || this.disposed) return false;
    const owner = this;
    const realm = this.global;
    const safe = (work) => {
      try {
        return work();
      } catch {
        owner.failures++;
        return null;
      }
    };
    const streams = new WeakMap();
    const readers = new WeakMap();
    const method = (target, key, handler) =>
      owner.patch(target, key, (descriptor) => ({
        ...descriptor,
        value: function (...args) {
          return handler.call(this, descriptor.value, args);
        },
      }));
    try {
      for (const key of ['response', 'responseText'])
        this.patch(realm.XMLHttpRequest.prototype, key, (descriptor) => ({
          ...descriptor,
          get() {
            const value = Reflect.apply(descriptor.get, this, []);
            if (
              this.readyState === 4 &&
              this.status >= 200 &&
              this.status < 300 &&
              typeof value === 'string'
            )
              safe(() => owner.playlist(this.responseURL, value));
            return value;
          },
        }));
      this.patch(realm.Response.prototype, 'body', (descriptor) => ({
        ...descriptor,
        get() {
          const value = Reflect.apply(descriptor.get, this, []);
          if (value && owner.knownResource(this.url))
            safe(() => streams.set(value, this.url));
          return value;
        },
      }));
      method(
        realm.ReadableStream.prototype,
        'getReader',
        function (original, args) {
          const reader = Reflect.apply(original, this, args);
          const parser = safe(() => owner.response(streams.get(this)));
          if (parser) readers.set(reader, parser);
          return reader;
        },
      );
      method(
        realm.ReadableStreamDefaultReader.prototype,
        'read',
        function (original, args) {
          const promise = Reflect.apply(original, this, args);
          const parser = readers.get(this);
          if (!parser) return promise;
          return promise.then(
            (result) => {
              safe(() =>
                result.done ? parser.close() : parser.write(result.value),
              );
              return result;
            },
            (cause) => {
              safe(() => parser.abort());
              throw cause;
            },
          );
        },
      );
      method(
        realm.ReadableStreamDefaultReader.prototype,
        'cancel',
        function (original, args) {
          safe(() => readers.get(this)?.abort());
          return Reflect.apply(original, this, args);
        },
      );
      method(
        realm.ReadableStreamDefaultReader.prototype,
        'releaseLock',
        function (original, args) {
          const value = Reflect.apply(original, this, args);
          safe(() => readers.get(this)?.abort());
          return value;
        },
      );
      method(realm.URL, 'createObjectURL', function (original, args) {
        const url = Reflect.apply(original, this, args);
        if (args[0] instanceof realm.MediaSource)
          safe(() => {
            owner.objectUrl(url, args[0]);
            const state = owner.sources.get(args[0]);
            if (!state || state.removeClose) return;
            const close = () => owner.closeSource(args[0]);
            args[0].addEventListener('sourceclose', close, { once: true });
            state.removeClose = () => {
              args[0].removeEventListener('sourceclose', close);
              state.removeClose = null;
            };
          });
        return url;
      });
      method(
        realm.MediaSource.prototype,
        'addSourceBuffer',
        function (original, args) {
          const value = Reflect.apply(original, this, args);
          safe(() => owner.sourceBuffer(this, value, args[0]));
          return value;
        },
      );
      method(
        realm.SourceBuffer.prototype,
        'appendBuffer',
        function (original, args) {
          const value = Reflect.apply(original, this, args);
          safe(() => owner.append(this, args[0]));
          return value;
        },
      );
      method(
        realm.HTMLMediaElement.prototype,
        'load',
        function (original, args) {
          if (owner.media.has(this)) safe(() => owner.invalidate(this));
          return Reflect.apply(original, this, args);
        },
      );
      this.patch(realm.HTMLMediaElement.prototype, 'src', (descriptor) => ({
        ...descriptor,
        set(value) {
          if (owner.media.has(this)) safe(() => owner.invalidate(this));
          return Reflect.apply(descriptor.set, this, [value]);
        },
      }));
      this.installed = true;
      return true;
    } catch {
      for (const restore of this.restorers.splice(0).reverse()) restore();
      this.failures++;
      return false;
    }
  }

  async settle() {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  stats() {
    return Object.freeze({
      disposed: this.disposed,
      installed: !!this.installed,
      playlists: this.playlists.size,
      playlistUrlCharacters: this.urlCharacterCount(),
      resources: this.resources.size,
      sources: this.sourceStates.size,
      media: this.mediaEntries().length,
      parsers: this.parsers.size,
      pendingHashBytes: this.pendingHashBytes,
      peakPendingHashBytes: this.peakPendingHashBytes,
      scratchBytes: this.scratchBytes,
      peakScratchBytes: this.peakScratchBytes,
      digestBytes: this.digestBytes,
      peakDigestBytes: this.peakDigestBytes,
      failures: this.failures,
    });
  }

  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const restore of this.restorers.splice(0).reverse()) {
      try {
        restore();
      } catch {
        this.failures++;
      }
    }
    for (const parser of this.parsers) parser.abort();
    for (const state of this.sourceStates) state.removeClose?.();
    this.playlists.clear();
    this.playlistVersions.clear();
    this.resources.clear();
    this.urls.clear();
    this.sourceStates.clear();
    this.notify();
    this.media = new WeakMap();
    this.mediaRefs.clear();
    this.installed = false;
    this.disposal = this.settle().then(() => this.stats());
    return this.disposal;
  }
}

export function createSourceBinding(options) {
  const binding = new SourceBinding(options);
  return Object.freeze({
    install: () => binding.install(),
    playlist: (url, text) => binding.playlist(url, text),
    response: (url) => binding.response(url),
    objectUrl: (url, source) => binding.objectUrl(url, source),
    sourceBuffer: (source, buffer, mime) =>
      binding.sourceBuffer(source, buffer, mime),
    append: (buffer, bytes) => binding.append(buffer, bytes),
    closeSource: (source) => binding.closeSource(source),
    resolve: (media) => binding.resolve(media),
    invalidate: (media) => binding.invalidate(media),
    release: (media) => binding.release(media),
    settle: () => binding.settle(),
    stats: () => binding.stats(),
    dispose: () => binding.dispose(),
  });
}
