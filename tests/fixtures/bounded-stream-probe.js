window.boundedStreamProbe = async () => {
  const url = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .find((value) => /\.m3u8(?:\?|$)/.test(value));
  if (!url) throw new Error('No observed playlist');
  const result = {
    status: 'INCOMPLETE',
    ranges: [],
    requests: [],
    nativeSamples: 0,
    closedNativeSamples: 0,
    comparisons: [],
  };
  const decoders = [];
  const Decoder = new Proxy(AudioDecoder, {
    construct(target, [options]) {
      const decoder = new target({
        ...options,
        output(sample) {
          result.nativeSamples++;
          options.output(sample);
          if (sample.format === null) result.closedNativeSamples++;
        },
      });
      decoders.push(decoder);
      return decoder;
    },
  });
  const sourceOptions = {
    library: Mediabunny,
    url,
    AudioDecoder: Decoder,
    fetch: (address, options) => {
      if (result.requests.length >= 60)
        throw new Error('Diagnostic request cap');
      result.requests.push({ host: new URL(address).hostname });
      return fetch(address, options);
    },
  };
  const source = createPcmSource(sourceOptions);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const clean = (candidate = source) => {
    const stats = candidate.stats();
    return (
      stats.activeTransactions === 0 &&
      stats.heldEncodedBytes === 0 &&
      stats.heldPcmBytes === 0 &&
      stats.openedDecoders === stats.closedDecoders &&
      result.nativeSamples === result.closedNativeSamples
    );
  };
  const collect = async (start, end, candidate = source) => {
    const item = {
      start,
      end,
      samples: [],
      frames: 0,
      peak: 0,
      maxGapSeconds: 0,
    };
    const pcm = [];
    let previousEnd;
    for await (const packet of candidate.read(start, end, {
      signal: controller.signal,
    })) {
      try {
        if (item.frames + packet.channels[0].length > 32768)
          throw new Error('Diagnostic PCM cap');
        const frames = packet.channels[0].length;
        if (previousEnd !== undefined)
          item.maxGapSeconds = Math.max(
            item.maxGapSeconds,
            Math.abs(packet.timestamp - previousEnd),
          );
        previousEnd = packet.timestamp + frames / packet.sampleRate;
        pcm.push({
          timestamp: packet.timestamp,
          sampleRate: packet.sampleRate,
          channels: packet.channels.map((channel) => channel.slice()),
        });
        item.samples.push({
          timestamp: packet.timestamp,
          sampleRate: packet.sampleRate,
          frames,
        });
        item.frames += frames;
        for (const channel of packet.channels)
          for (const value of channel)
            item.peak = Math.max(item.peak, Math.abs(value));
      } finally {
        packet.release();
      }
    }
    const first = item.samples[0];
    item.coversRange = Boolean(
      first &&
        first.timestamp <= start + 1 / first.sampleRate &&
        previousEnd >= end,
    );
    item.cleanupPassed = clean(candidate);
    item.control = candidate !== source;
    result.ranges.push(item);
    if (
      !item.coversRange ||
      !item.cleanupPassed ||
      item.maxGapSeconds > 1 / first.sampleRate ||
      !item.peak
    )
      throw new Error('Bounded decoded range validation failed');
    return pcm;
  };
  const compare = (actual, reference, start, end) => {
    let count = 0,
      peak = 0,
      square = 0,
      firstMismatch;
    for (const packet of actual) {
      const other = reference.find(
        (candidate) =>
          Math.abs(candidate.timestamp - packet.timestamp) < 0.000002,
      );
      if (!other) throw new Error('Reference packet missing');
      for (let channel = 0; channel < packet.channels.length; channel++) {
        const plane = packet.channels[channel],
          baseline = other.channels[channel];
        if (plane.length !== baseline.length)
          throw new Error('Reference sample count changed');
        for (let frame = 0; frame < plane.length; frame++) {
          const time = packet.timestamp + frame / packet.sampleRate;
          if (time < start || time >= end) continue;
          const delta = Math.abs(plane[frame] - baseline[frame]);
          if (delta > 1e-5 && firstMismatch === undefined) firstMismatch = time;
          peak = Math.max(peak, delta);
          square += delta * delta;
          count++;
        }
      }
    }
    return {
      start,
      end,
      count,
      peak,
      rms: Math.sqrt(square / count),
      firstMismatch,
      matches: count > 0 && peak < 1e-5,
    };
  };
  try {
    result.metadata = await source.info({ signal: controller.signal });
    await collect(0, 0.1);
    for (const [start, end] of [
      [9.95, 10.06],
      [120, 120.1],
    ]) {
      const actual = await collect(start, end);
      const reference = await collect(start - 0.25, end);
      result.comparisons.push(compare(actual, reference, start, end));
      if (start === 9.95) {
        const control = createPcmSourceWithoutPreroll(sourceOptions);
        try {
          const contaminated = await collect(start, end, control);
          result.prerollControl = compare(contaminated, reference, start, end);
          result.prerollControl.rejected = !result.prerollControl.matches;
        } finally {
          control.dispose();
        }
      }
    }
    const iterator = source.read(20, 20.2, { signal: controller.signal });
    const { value } = await iterator.next();
    await iterator.return();
    result.earlyReturnPassed = value.released && clean();
    const abort = new AbortController();
    const cancelled = source.read(30, 30.2, {
      signal: AbortSignal.any([controller.signal, abort.signal]),
    });
    const held = (await cancelled.next()).value;
    abort.abort();
    try {
      await cancelled.next();
    } catch (error) {
      result.abortPassed =
        error.name === 'AbortError' && held.released && clean();
    }
    result.status =
      result.comparisons.every((comparison) => comparison.matches) &&
      result.earlyReturnPassed &&
      result.abortPassed &&
      result.prerollControl?.rejected
        ? 'PASSED'
        : 'INCOMPLETE';
  } catch (error) {
    result.error = {
      name: error.name,
      message: error.message.replace(/https?:\/\/[^\s)]+/g, '[url]'),
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    source.dispose();
    result.stats = source.stats();
    result.decoderStates = decoders.map((decoder) => decoder.state);
    result.cleanupPassed =
      clean() && result.decoderStates.every((state) => state === 'closed');
  }
  return result;
};
