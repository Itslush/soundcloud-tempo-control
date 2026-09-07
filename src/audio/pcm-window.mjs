function error(message, name = 'Error') {
  return Object.assign(new Error(message), { name });
}

function aborted() {
  return error('PCM window operation cancelled.', 'AbortError');
}

function positiveFrame(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

class PcmWindow {
  constructor({ source, maxBytes = 8 * 1024 * 1024, readAheadSeconds = 2 }) {
    if (
      !source ||
      typeof source.read !== 'function' ||
      typeof source.dispose !== 'function'
    )
      throw new TypeError('A bounded PCM source is required.');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 16 ||
      !Number.isFinite(readAheadSeconds) ||
      readAheadSeconds <= 0 ||
      readAheadSeconds > 30
    )
      throw new RangeError('Invalid PCM window limits.');
    this.source = source;
    this.maxBytes = maxBytes;
    this.readAheadSeconds = readAheadSeconds;
    this.blocks = [];
    this.cacheBytes = 0;
    this.leaseBytes = 0;
    this.reservedBytes = 0;
    this.peakOwnedBytes = 0;
    this.peakBudgetedBytes = 0;
    this.sourceReads = 0;
    this.cacheHits = 0;
    this.generation = 0;
    this.disposed = false;
    this.job = null;
    this.lease = null;
    this.closing = null;
  }

  check(job) {
    if (
      this.disposed ||
      (job?.generation !== undefined && job.generation !== this.generation)
    )
      throw aborted();
    if (job?.controller.signal.aborted)
      throw job.controller.signal.reason || aborted();
  }

  account() {
    const owned = this.cacheBytes + this.leaseBytes;
    const budgeted = owned + this.reservedBytes;
    if (budgeted > this.maxBytes)
      throw error('PCM window byte budget exceeded.', 'QuotaExceededError');
    this.peakOwnedBytes = Math.max(this.peakOwnedBytes, owned);
    this.peakBudgetedBytes = Math.max(this.peakBudgetedBytes, budgeted);
  }

  stats() {
    return Object.freeze({
      cacheBytes: this.cacheBytes,
      leaseBytes: this.leaseBytes,
      reservedBytes: this.reservedBytes,
      ownedBytes: this.cacheBytes + this.leaseBytes,
      peakOwnedBytes: this.peakOwnedBytes,
      peakBudgetedBytes: this.peakBudgetedBytes,
      blocks: this.blocks.length,
      sourceReads: this.sourceReads,
      cacheHits: this.cacheHits,
      activeJobs: this.job ? 1 : 0,
      activeLeases: this.lease ? 1 : 0,
      generation: this.generation,
      disposed: this.disposed,
      ...(this.sampleRate ? { sampleRate: this.sampleRate } : {}),
      ...(this.totalSourceFrames === undefined
        ? {}
        : { totalSourceFrames: this.totalSourceFrames }),
    });
  }

  metadata() {
    return Object.freeze({
      sampleRate: this.sampleRate,
      channels: 2,
      ...(this.durationHint === undefined
        ? {}
        : { durationHint: this.durationHint }),
      ...(this.totalSourceFrames === undefined
        ? {}
        : { totalSourceFrames: this.totalSourceFrames }),
    });
  }

  run(signal, work) {
    this.check();
    if (signal?.aborted) return Promise.reject(signal.reason || aborted());
    if (this.job || this.lease || this.closing)
      return Promise.reject(
        error(
          'A PCM window job or lease is already active.',
          'InvalidStateError',
        ),
      );
    const job = {
      controller: new AbortController(),
      generation: this.generation,
    };
    const cancel = () => job.controller.abort(signal.reason || aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    this.job = job;
    job.done = Promise.resolve()
      .then(() => work(job))
      .finally(() => {
        signal?.removeEventListener('abort', cancel);
        this.reservedBytes = 0;
        if (this.job === job) this.job = null;
      });
    return job.done;
  }

  async info({ signal } = {}) {
    this.check();
    if (signal?.aborted) throw signal.reason || aborted();
    if (this.initialized) return this.metadata();
    return this.run(signal, async (job) => {
      if (typeof this.source.info === 'function') {
        const info = await this.source.info({ signal: job.controller.signal });
        this.check(job);
        if (Number.isFinite(info?.duration) && info.duration >= 0)
          this.durationHint = info.duration;
      }
      await this.fill(job, 0, 1);
      this.check(job);
      if (!this.sampleRate || !this.covers(0, 1))
        throw error('The source has no initial PCM sample.', 'DataError');
      this.initialized = true;
      return this.metadata();
    });
  }

  frameAt(timestamp) {
    const value =
      this.anchorFrame +
      Math.round((timestamp - this.anchorTimestamp) * this.sampleRate);
    if (!Number.isSafeInteger(value))
      throw error('PCM timestamp exceeds frame precision.', 'DataError');
    return value;
  }

  timestampAt(frame) {
    return this.anchorTimestamp + (frame - this.anchorFrame) / this.sampleRate;
  }

  packetFrame(packet, previousEnd) {
    if (
      !packet ||
      typeof packet.release !== 'function' ||
      !Number.isFinite(packet.timestamp) ||
      !Number.isSafeInteger(packet.sampleRate) ||
      packet.sampleRate < 8000 ||
      packet.sampleRate > 192000 ||
      !Array.isArray(packet.channels) ||
      packet.channels.length !== 2 ||
      packet.channels.some((plane) => !(plane instanceof Float32Array)) ||
      !packet.channels[0].length ||
      packet.channels[0].length !== packet.channels[1].length
    )
      throw error('Invalid stereo PCM packet.', 'DataError');
    if (!this.sampleRate) {
      this.sampleRate = packet.sampleRate;
      this.anchorTimestamp = packet.timestamp;
      this.anchorFrame = Math.round(packet.timestamp * packet.sampleRate);
      if (!Number.isSafeInteger(this.anchorFrame))
        throw error('PCM origin exceeds frame precision.', 'DataError');
    }
    if (packet.sampleRate !== this.sampleRate)
      throw error('PCM sample rate changed.', 'DataError');
    const frame =
      previousEnd === undefined ? this.frameAt(packet.timestamp) : previousEnd;
    if (
      Math.abs(packet.timestamp - this.timestampAt(frame)) >
      Math.max(1 / this.sampleRate, 0.000001)
    )
      throw error(
        'PCM timestamps do not match carried frame counts.',
        'DataError',
      );
    if (!Number.isSafeInteger(frame + packet.channels[0].length))
      throw error('PCM range exceeds frame precision.', 'DataError');
    return frame;
  }

  covers(start, end) {
    let cursor = start;
    for (const block of this.blocks) {
      if (block.end <= cursor) continue;
      if (block.start > cursor) return false;
      cursor = Math.max(cursor, block.end);
      if (cursor >= end) return true;
    }
    return cursor >= end;
  }

  missing(start, end) {
    let cursor = start;
    const spans = [];
    for (const block of this.blocks) {
      if (block.end <= cursor) continue;
      if (block.start >= end) break;
      if (block.start > cursor)
        spans.push([cursor, Math.min(block.start, end)]);
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < end) spans.push([cursor, end]);
    return spans;
  }

  evict(start, end) {
    this.blocks = this.blocks.filter((block) => {
      if (block.end > start && block.start < end) return true;
      this.cacheBytes -= (block.end - block.start) * 8;
      block.channels.length = 0;
      return false;
    });
  }

  clearCache() {
    for (const block of this.blocks) block.channels.length = 0;
    this.blocks.length = 0;
    this.cacheBytes = 0;
  }

  retain(packet, packetStart, keepStart, keepEnd, requiredEnd) {
    const packetEnd = packetStart + packet.channels[0].length;
    const start = Math.max(0, packetStart, keepStart);
    const end = Math.min(packetEnd, keepEnd);
    let capacityReached = false;
    for (const [from, to] of this.missing(start, end)) {
      const freeFrames = Math.floor(
        (this.maxBytes -
          this.cacheBytes -
          this.leaseBytes -
          this.reservedBytes) /
          8,
      );
      const stop = Math.min(to, from + freeFrames);
      if (stop < Math.min(to, requiredEnd))
        throw error('PCM window byte budget exceeded.', 'QuotaExceededError');
      if (stop > from) {
        const bytes = (stop - from) * 8;
        this.cacheBytes += bytes;
        this.account();
        try {
          const channels = packet.channels.map((plane) =>
            plane.slice(from - packetStart, stop - packetStart),
          );
          if (channels.some((plane) => !plane.every(Number.isFinite)))
            throw error('PCM contains non-finite samples.', 'DataError');
          this.blocks.push({ start: from, end: stop, channels });
          this.blocks.sort((left, right) => left.start - right.start);
        } catch (cause) {
          this.cacheBytes -= bytes;
          throw cause;
        }
      }
      if (stop < to) capacityReached = true;
    }
    return capacityReached;
  }

  acceptEof(result, lastFrame) {
    if (!result || result.endOfStream !== true) return;
    if (
      !this.sampleRate ||
      result.sampleRate !== this.sampleRate ||
      !Number.isFinite(result.endTimestamp)
    )
      throw error('EOF has no verified decoded sample format.', 'DataError');
    const reportedFrame = this.frameAt(result.endTimestamp);
    const frame = lastFrame ?? reportedFrame;
    if (
      frame < 0 ||
      Math.abs(reportedFrame - frame) > 1 ||
      Math.abs(result.endTimestamp - this.timestampAt(frame)) >
        1 / this.sampleRate +
          Number.EPSILON * Math.max(1, Math.abs(result.endTimestamp)) * 2 ||
      this.blocks.some((block) => block.end > frame) ||
      (this.totalSourceFrames !== undefined && this.totalSourceFrames !== frame)
    )
      throw error('Decoded EOF contradicts retained PCM.', 'DataError');
    this.totalSourceFrames = frame;
  }

  async fill(job, startFrame, requiredEnd) {
    this.check(job);
    let keepEnd = this.sampleRate
      ? Math.max(
          requiredEnd,
          startFrame + Math.ceil(this.readAheadSeconds * this.sampleRate),
        )
      : undefined;
    const start = this.sampleRate
      ? Math.max(0, this.timestampAt(startFrame))
      : 0;
    const end = this.sampleRate
      ? this.timestampAt(keepEnd)
      : this.readAheadSeconds;
    const iterator = this.source
      .read(start, end, {
        signal: job.controller.signal,
        allowEndOfStream: true,
      })
      [Symbol.asyncIterator]();
    this.sourceReads++;
    let previousEnd;
    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          this.check(job);
          this.acceptEof(result.value, previousEnd);
          break;
        }
        const packet = result.value;
        let full;
        try {
          this.check(job);
          const frame = this.packetFrame(packet, previousEnd);
          previousEnd = frame + packet.channels[0].length;
          keepEnd ??= Math.ceil(
            this.anchorFrame + (end - this.anchorTimestamp) * this.sampleRate,
          );
          full = this.retain(packet, frame, startFrame, keepEnd, requiredEnd);
        } finally {
          packet?.release?.();
        }
        if (full) break;
      }
    } finally {
      await iterator.return?.();
    }
    this.check(job);
    const clippedEnd =
      this.totalSourceFrames === undefined
        ? requiredEnd
        : Math.min(requiredEnd, this.totalSourceFrames);
    if (startFrame < clippedEnd && !this.covers(startFrame, clippedEnd))
      throw error(
        'Decoded PCM does not cover the requested window.',
        'DataError',
      );
  }

  makeLease(start, end) {
    const bytes = Math.max(0, end - start) * 8;
    this.reservedBytes = bytes;
    this.account();
    const channels = [
      new Float32Array(Math.max(0, end - start)),
      new Float32Array(Math.max(0, end - start)),
    ];
    for (const block of this.blocks) {
      const from = Math.max(start, block.start);
      const to = Math.min(end, block.end);
      if (from >= to) continue;
      for (let channel = 0; channel < 2; channel++)
        channels[channel].set(
          block.channels[channel].subarray(
            from - block.start,
            to - block.start,
          ),
          from - start,
        );
    }
    this.reservedBytes = 0;
    this.leaseBytes = bytes;
    this.account();
    let released = false;
    const lease = Object.freeze({
      sampleRate: this.sampleRate,
      pcmStartFrame: start,
      channels,
      ...(this.totalSourceFrames === undefined
        ? {}
        : { totalSourceFrames: this.totalSourceFrames }),
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        channels.length = 0;
        if (this.lease === lease) {
          this.lease = null;
          this.leaseBytes = 0;
        }
      },
    });
    this.lease = lease;
    return lease;
  }

  async acquire(startFrame, endFrame, { signal } = {}) {
    if (
      !positiveFrame(startFrame) ||
      !positiveFrame(endFrame) ||
      endFrame <= startFrame
    )
      throw new RangeError(
        'PCM window bounds must be increasing non-negative integer frames.',
      );
    if (!this.initialized)
      throw error(
        'Read PCM info before acquiring a window.',
        'InvalidStateError',
      );
    return this.run(signal, async (job) => {
      this.check(job);
      if (
        this.totalSourceFrames !== undefined &&
        startFrame >= this.totalSourceFrames
      )
        return this.makeLease(this.totalSourceFrames, this.totalSourceFrames);
      let end =
        this.totalSourceFrames === undefined
          ? endFrame
          : Math.min(endFrame, this.totalSourceFrames);
      const bytes = (end - startFrame) * 8;
      if (!Number.isSafeInteger(bytes) || bytes * 2 > this.maxBytes)
        throw error(
          'PCM window needs more cache and lease space than allowed.',
          'QuotaExceededError',
        );
      this.evict(
        Math.max(0, startFrame - 128),
        Math.max(
          end,
          startFrame + Math.ceil(this.readAheadSeconds * this.sampleRate),
        ),
      );
      const requiredBytes = () =>
        this.missing(startFrame, end).reduce(
          (total, [from, to]) => total + (to - from) * 8,
          0,
        );
      if (this.cacheBytes + bytes + requiredBytes() > this.maxBytes)
        this.evict(startFrame, end);
      if (this.cacheBytes + bytes + requiredBytes() > this.maxBytes)
        this.clearCache();
      this.reservedBytes = bytes;
      this.account();
      if (this.covers(startFrame, end)) this.cacheHits++;
      else {
        for (const [from, to] of this.missing(startFrame, end)) {
          if (this.covers(from, to)) continue;
          await this.fill(job, from, to);
          this.check(job);
          if (this.totalSourceFrames !== undefined) break;
        }
      }
      this.check(job);
      end =
        this.totalSourceFrames === undefined
          ? endFrame
          : Math.min(endFrame, this.totalSourceFrames);
      if (startFrame >= end) return this.makeLease(end, end);
      if (!this.covers(startFrame, end))
        throw error('PCM cache has a coverage gap.', 'DataError');
      return this.makeLease(startFrame, end);
    });
  }

  async reset() {
    if (this.disposal) return this.disposal;
    if (this.closing) return this.closing;
    this.generation++;
    this.lease?.release();
    this.clearCache();
    const job = this.job;
    job?.controller.abort(aborted());
    this.closing = (async () => {
      try {
        await job?.done;
      } catch {}
      this.clearCache();
      this.reservedBytes = 0;
      return this.stats();
    })();
    try {
      return await this.closing;
    } finally {
      this.closing = null;
    }
  }

  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      try {
        await this.reset();
      } finally {
        await this.source.dispose();
      }
      return this.stats();
    })();
    return this.disposal;
  }
}

export function createPcmWindow(options) {
  const window = new PcmWindow(options);
  return Object.freeze({
    info: (options) => window.info(options),
    acquire: (start, end, options) => window.acquire(start, end, options),
    reset: () => window.reset(),
    dispose: () => window.dispose(),
    stats: () => window.stats(),
  });
}
