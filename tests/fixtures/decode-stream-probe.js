window.decodeStreamProbe = async () => {
  const url = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .find((value) => /\.m3u8(?:\?|$)/.test(value));
  if (!url) throw new Error('No observed playlist');
  const stats = {
    ranges: [],
    requests: [],
    deliveredBytes: 0,
    receivedBytes: 0,
    deliveredByteLimit: 2 * 1024 * 1024,
    perResponseLimit: 512 * 1024,
    nativeSamples: 0,
    closedNativeSamples: 0,
    livePcmEquivalentBytes: 0,
    peakPcmEquivalentBytes: 0,
    peakDecodeQueue: 0,
    status: 'INCOMPLETE',
  };
  const controllers = new Set();
  const decoders = [];
  const allocations = new WeakMap();
  const NativeDecoder = AudioDecoder;
  const close = AudioData.prototype.close;
  const clone = AudioData.prototype.clone;
  let input;
  const retain = (data) => {
    const bytes = data.numberOfFrames * data.numberOfChannels * 4;
    allocations.set(data, bytes);
    stats.nativeSamples++;
    stats.livePcmEquivalentBytes += bytes;
    stats.peakPcmEquivalentBytes = Math.max(
      stats.peakPcmEquivalentBytes,
      stats.livePcmEquivalentBytes,
    );
  };
  AudioData.prototype.close = function () {
    const bytes = allocations.get(this);
    if (bytes !== undefined) {
      stats.livePcmEquivalentBytes -= bytes;
      stats.closedNativeSamples++;
      allocations.delete(this);
    }
    return Reflect.apply(close, this, []);
  };
  AudioData.prototype.clone = function () {
    const data = Reflect.apply(clone, this, []);
    retain(data);
    return data;
  };
  window.AudioDecoder = new Proxy(NativeDecoder, {
    construct(target, [options]) {
      const node = new target({
        ...options,
        output(data) {
          retain(data);
          options.output(data);
        },
      });
      const decode = node.decode;
      node.decode = function (chunk) {
        const result = Reflect.apply(decode, this, [chunk]);
        stats.peakDecodeQueue = Math.max(
          stats.peakDecodeQueue,
          this.decodeQueueSize,
        );
        return result;
      };
      decoders.push(node);
      return node;
    },
  });
  const permitted = (value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      (parsed.hostname.endsWith('.sndcdn.com') ||
        parsed.hostname.endsWith('.media-streaming.soundcloud.cloud'))
    );
  };
  const fetchBounded = async (resource, options = {}) => {
    const address =
      resource instanceof Request ? resource.url : String(resource);
    if (!permitted(address) || stats.requests.length >= 20)
      throw new Error('Source request limit');
    const controller = new AbortController();
    controllers.add(controller);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const entry = {
      host: new URL(address).hostname,
      bytes: 0,
      complete: false,
      cancelled: false,
    };
    stats.requests.push(entry);
    const response = await fetch(resource, {
      ...options,
      signal,
      credentials: 'omit',
    });
    if (!response.ok || !permitted(response.url)) {
      controller.abort();
      throw new Error('Source response rejected');
    }
    const reader = response.body.getReader();
    const body = new ReadableStream(
      {
        async pull(output) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              entry.complete = true;
              controllers.delete(controller);
              reader.releaseLock();
              output.close();
              return;
            }
            stats.receivedBytes += chunk.value.length;
            if (
              entry.bytes + chunk.value.length > stats.perResponseLimit ||
              stats.deliveredBytes + chunk.value.length >
                stats.deliveredByteLimit
            ) {
              controller.abort();
              await reader.cancel();
              throw new Error('Source byte limit');
            }
            entry.bytes += chunk.value.length;
            stats.deliveredBytes += chunk.value.length;
            output.enqueue(chunk.value);
          } catch (error) {
            controllers.delete(controller);
            output.error(error);
          }
        },
        async cancel(reason) {
          entry.cancelled = true;
          controller.abort();
          controllers.delete(controller);
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  };
  const timer = setTimeout(() => {
    input?.dispose();
    for (const controller of controllers) controller.abort();
  }, 20000);
  try {
    const { Input, UrlSource, HLS_FORMATS, AudioSampleSink } = Mediabunny;
    for (const [start, end] of [
      [0, 0.1],
      [9.95, 10.06],
      [120, 120.1],
    ]) {
      input = new Input({
        source: new UrlSource(url, {
          maxCacheSize: 262144,
          parallelism: 1,
          getRetryDelay: () => null,
          fetchFn: fetchBounded,
        }),
        formats: HLS_FORMATS,
      });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode()))
        throw new Error('Audio decoding unavailable');
      const item = {
        start,
        end,
        frames: 0,
        peak: 0,
        invalid: 0,
        maxGapSeconds: 0,
        samples: [],
      };
      stats.ranges.push(item);
      item.codec = await track.getCodecParameterString();
      item.sampleRate = await track.getSampleRate();
      item.channels = await track.getNumberOfChannels();
      const sink = new AudioSampleSink(track);
      let previousEnd;
      for await (const sample of sink.samples(start, end)) {
        try {
          if (
            sample.numberOfChannels > 2 ||
            sample.numberOfFrames > 8192 ||
            item.samples.length >= 16
          )
            throw new Error('PCM sample limit');
          const data = new Float32Array(sample.numberOfFrames);
          for (let channel = 0; channel < sample.numberOfChannels; channel++) {
            sample.copyTo(data, { planeIndex: channel, format: 'f32-planar' });
            for (const value of data) {
              if (!Number.isFinite(value)) item.invalid++;
              else item.peak = Math.max(item.peak, Math.abs(value));
            }
          }
          if (previousEnd !== undefined)
            item.maxGapSeconds = Math.max(
              item.maxGapSeconds,
              Math.abs(sample.timestamp - previousEnd),
            );
          previousEnd = sample.timestamp + sample.duration;
          item.samples.push({
            timestamp: sample.timestamp,
            duration: sample.duration,
            frames: sample.numberOfFrames,
            sampleRate: sample.sampleRate,
          });
          item.frames += sample.numberOfFrames;
        } finally {
          sample.close();
        }
      }
      item.coversRange =
        item.samples.length > 0 &&
        item.samples[0].timestamp <= start + 1 / item.sampleRate &&
        previousEnd >= end;
      if (
        !item.coversRange ||
        item.invalid ||
        item.peak === 0 ||
        item.maxGapSeconds > 1 / item.sampleRate
      )
        throw new Error('Decoded range validation failed');
      input.dispose();
      item.disposed = input.disposed;
      input = null;
    }
    stats.status = 'DECODED';
  } catch (error) {
    stats.error = {
      name: error.name,
      message: error.message.replace(/https?:\/\/[^\s)]+/g, '[url]'),
    };
  } finally {
    clearTimeout(timer);
    input?.dispose();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    await new Promise((resolve) => setTimeout(resolve, 100));
    stats.decoderStates = decoders.map((decoder) => decoder.state);
    stats.cleanupPassed =
      stats.livePcmEquivalentBytes === 0 &&
      stats.decoderStates.every((state) => state === 'closed');
    window.AudioDecoder = NativeDecoder;
    AudioData.prototype.close = close;
    AudioData.prototype.clone = clone;
  }
  return stats;
};
