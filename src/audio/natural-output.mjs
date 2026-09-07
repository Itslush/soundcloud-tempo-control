const QUANTUM = 128;
const PADDING = 128;
const DEFAULT_LIMITS = Object.freeze({
  maxBufferBytes: 32 * 1024 * 1024,
  maxNodes: 16,
  maxAheadSeconds: 4,
});

function validSampleRate(value) {
  if (!Number.isInteger(value) || value < 8000 || value > 384000)
    throw new RangeError('Unsupported sample rate');
  return value;
}

function readLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits))
    throw new TypeError('Limits must be an object');
  if (Object.keys(limits).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key)))
    throw new TypeError('Unknown output limit');
  const result = { ...DEFAULT_LIMITS, ...limits };
  if (
    !Number.isSafeInteger(result.maxBufferBytes) ||
    result.maxBufferBytes < 8 ||
    !Number.isSafeInteger(result.maxNodes) ||
    result.maxNodes < 1 ||
    !Number.isFinite(result.maxAheadSeconds) ||
    result.maxAheadSeconds <= 0
  )
    throw new RangeError('Output limits must be finite and positive');
  return Object.freeze(result);
}

function readClock(clock, sampleRate, outputRate) {
  if (
    !clock ||
    typeof clock !== 'object' ||
    !Array.isArray(clock.intervals) ||
    typeof clock.sourceAt !== 'function' ||
    typeof clock.outputAt !== 'function'
  )
    throw new TypeError('A verified rate clock is required');
  if (
    clock.sourceSampleRate !== sampleRate ||
    clock.outputSampleRate !== outputRate
  )
    throw new RangeError('Clock and audio sample rates must match');
  const { outputStartFrame, outputEndFrame, sourceStartFrame, sourceEndFrame } =
    clock;
  const frameCount = outputEndFrame - outputStartFrame;
  if (
    !Number.isSafeInteger(outputStartFrame) ||
    outputStartFrame < 0 ||
    outputStartFrame % QUANTUM ||
    !Number.isSafeInteger(outputEndFrame) ||
    frameCount <= 0 ||
    frameCount % QUANTUM ||
    frameCount > outputRate * 2 ||
    outputEndFrame > (outputRate * 86400) / 0.025 ||
    !Number.isFinite(sourceStartFrame) ||
    sourceStartFrame < 0 ||
    !Number.isFinite(sourceEndFrame) ||
    sourceEndFrame <= sourceStartFrame ||
    sourceEndFrame > sampleRate * 86400 ||
    clock.intervals.length !== frameCount / QUANTUM
  )
    throw new RangeError('Invalid rate-clock window');
  let sourceFrame = sourceStartFrame;
  const intervals = clock.intervals.map((interval, index) => {
    const outputFrame = outputStartFrame + index * QUANTUM;
    if (
      !interval ||
      !Number.isFinite(interval.rate) ||
      interval.rate < 0.025 ||
      interval.rate > 4 ||
      Math.fround(interval.rate) !== interval.rate ||
      interval.outputFrame !== outputFrame ||
      interval.sourceFrame !== sourceFrame
    )
      throw new RangeError('Invalid rate-clock interval');
    const slope = (interval.rate * sampleRate) / outputRate;
    if (interval.sourceFramesPerOutputFrame !== slope)
      throw new RangeError('Rate-clock slope does not match its sample rates');
    const result = { outputFrame, sourceFrame, rate: interval.rate, slope };
    const next = sourceFrame + QUANTUM * slope;
    if (!(next > sourceFrame))
      throw new RangeError('Rate-clock source position must advance');
    sourceFrame = next;
    return result;
  });
  if (
    sourceFrame !== sourceEndFrame ||
    clock.sourceAt(outputStartFrame) !== sourceStartFrame ||
    clock.sourceAt(outputEndFrame) !== sourceEndFrame ||
    clock.outputAt(sourceStartFrame) !== outputStartFrame ||
    clock.outputAt(sourceEndFrame) !== outputEndFrame
  )
    throw new RangeError('Rate-clock endpoints do not match its intervals');
  return {
    outputStartFrame,
    outputEndFrame,
    sourceStartFrame,
    sourceEndFrame,
    intervals,
  };
}

function readPcm(
  { clock, sampleRate, pcmStartFrame, channels, totalSourceFrames },
  outputRate,
) {
  validSampleRate(sampleRate);
  const plan = readClock(clock, sampleRate, outputRate);
  if (
    !Number.isSafeInteger(pcmStartFrame) ||
    pcmStartFrame < 0 ||
    !Array.isArray(channels) ||
    channels.length !== 2 ||
    channels.some((channel) => !(channel instanceof Float32Array)) ||
    !channels[0].length ||
    channels[0].length !== channels[1].length
  )
    throw new TypeError(
      'PCM must contain two equal nonempty Float32 channels and an absolute frame origin',
    );
  const pcmEndFrame = pcmStartFrame + channels[0].length;
  if (!Number.isSafeInteger(pcmEndFrame))
    throw new RangeError('PCM range exceeds frame precision');
  if (totalSourceFrames !== undefined) {
    if (
      !Number.isSafeInteger(totalSourceFrames) ||
      totalSourceFrames <= 0 ||
      pcmEndFrame > totalSourceFrames ||
      plan.sourceStartFrame >= totalSourceFrames
    )
      throw new RangeError(
        'PCM or source position is outside the declared file',
      );
    if (plan.sourceEndFrame > totalSourceFrames) {
      const interval = plan.intervals.findLast(
        (value) => value.sourceFrame <= totalSourceFrames,
      );
      const end =
        interval.outputFrame +
        (totalSourceFrames - interval.sourceFrame) / interval.slope;
      if (
        clock.outputAt(totalSourceFrames) !== end ||
        !Number.isFinite(end) ||
        end <= plan.outputStartFrame ||
        end > plan.outputEndFrame
      )
        throw new RangeError('Invalid EOF inverse mapping');
      plan.sourceEndFrame = totalSourceFrames;
      plan.outputEndFrame = end;
    }
  }
  const bufferStartFrame = Math.max(
    0,
    Math.floor(plan.sourceStartFrame) - PADDING,
  );
  let bufferEndFrame = Math.ceil(plan.sourceEndFrame) + PADDING;
  if (totalSourceFrames !== undefined) {
    bufferEndFrame = Math.min(totalSourceFrames, bufferEndFrame);
  }
  if (pcmStartFrame > bufferStartFrame || pcmEndFrame < bufferEndFrame)
    throw new RangeError(
      'PCM does not cover the source window and 128-frame interpolation padding',
    );
  return {
    ...plan,
    sampleRate,
    bufferStartFrame,
    bufferEndFrame,
    copyOffset: bufferStartFrame - pcmStartFrame,
    bufferBytes: (bufferEndFrame - bufferStartFrame) * 8,
  };
}

export function createNaturalOutput({ context, destination, limits = {} }) {
  if (
    !context ||
    typeof context.createBuffer !== 'function' ||
    typeof context.createBufferSource !== 'function' ||
    typeof context.createGain !== 'function' ||
    typeof context.addEventListener !== 'function' ||
    typeof context.removeEventListener !== 'function' ||
    !destination ||
    destination.context !== context
  )
    throw new TypeError(
      'A context and destination from the same audio graph are required',
    );
  const outputRate = validSampleRate(context.sampleRate);
  const budget = readLimits(limits);
  const entries = new Set();
  let bufferBytes = 0,
    generation = 0,
    disposed = false,
    lastOutputEndFrame = null,
    cleanupErrors = 0;
  const now = () => {
    if (!Number.isFinite(context.currentTime) || context.currentTime < 0)
      throw new RangeError('Invalid audio context time');
    return context.currentTime;
  };
  const available = () => {
    if (disposed) throw new Error('Natural output is disposed');
    if (context.state === 'closed') throw new Error('Audio context is closed');
    if (context.sampleRate !== outputRate)
      throw new Error('Audio context sample rate changed');
  };
  const stats = () => {
    const time = now();
    let scheduledAheadSeconds = 0;
    for (const entry of entries)
      scheduledAheadSeconds = Math.max(
        scheduledAheadSeconds,
        entry.outputEndFrame / outputRate - time,
      );
    return Object.freeze({
      generation,
      disposed,
      nodes: entries.size * 2,
      sourceNodes: entries.size,
      gainNodes: entries.size,
      bufferBytes,
      lastOutputEndFrame,
      cleanupErrors,
      scheduledAheadSeconds,
    });
  };
  function release(entry, stop) {
    if (!entries.delete(entry)) return [];
    bufferBytes -= entry.bufferBytes;
    const errors = [];
    const attempt = (action) => {
      try {
        action();
      } catch (error) {
        cleanupErrors++;
        errors.push(error);
      }
    };
    const node = entry.node;
    attempt(() => node.removeEventListener('ended', entry.onEnded));
    if (stop && entry.started) attempt(() => node.stop());
    attempt(() => node.disconnect());
    if (entry.gain) {
      attempt(() => entry.gain.gain.cancelScheduledValues(0));
      attempt(() => {
        entry.gain.gain.value = 0;
      });
      attempt(() => entry.gain.disconnect());
    }
    attempt(() => {
      node.buffer = null;
    });
    entry.node = null;
    entry.gain = null;
    entry.onEnded = null;
    return errors;
  }
  function own(node, plan) {
    const entry = {
      node,
      gain: null,
      bufferBytes: plan.bufferBytes,
      outputStartFrame: plan.outputStartFrame,
      outputEndFrame: plan.outputEndFrame,
      generation,
      started: false,
    };
    entry.onEnded = () => {
      if (entry.generation === generation) release(entry, false);
    };
    entries.add(entry);
    bufferBytes += entry.bufferBytes;
    return entry;
  }
  function clear() {
    generation++;
    lastOutputEndFrame = null;
    const errors = [...entries].flatMap((entry) => release(entry, true));
    if (errors.length)
      throw new AggregateError(errors, 'Natural output cleanup failed');
    return stats();
  }
  function reset() {
    return disposed ? stats() : clear();
  }
  function truncate(outputFrame) {
    available();
    if (
      !Number.isSafeInteger(outputFrame) ||
      outputFrame < 0 ||
      outputFrame % QUANTUM
    )
      throw new RangeError('Truncation must align to a render quantum');
    const cutTime = outputFrame / outputRate;
    if (cutTime < now())
      throw new RangeError('Truncation cannot begin in the past');
    if (
      ![...entries].some(
        (entry) =>
          entry.outputStartFrame <= outputFrame &&
          outputFrame <= entry.outputEndFrame,
      )
    )
      throw new RangeError('Truncation must be inside a scheduled window');
    const epoch = generation;
    try {
      for (const entry of [...entries]) {
        if (entry.outputStartFrame >= outputFrame) {
          const errors = release(entry, true);
          if (errors.length)
            throw new AggregateError(errors, 'Future output cleanup failed');
        } else if (entry.outputEndFrame > outputFrame) {
          const gateTime = Math.max(0, (outputFrame - 0.5) / outputRate);
          entry.node.stop(cutTime);
          entry.node.playbackRate.cancelScheduledValues(gateTime);
          entry.gain.gain.cancelScheduledValues(gateTime);
          entry.gain.gain.setValueAtTime(0, gateTime);
          entry.outputEndFrame = outputFrame;
        }
      }
      if (epoch !== generation || disposed || cutTime < now())
        throw new Error('Truncation became stale');
      lastOutputEndFrame = outputFrame;
      return stats();
    } catch (error) {
      let cleanup = [];
      try {
        clear();
      } catch (failure) {
        cleanup =
          failure instanceof AggregateError ? failure.errors : [failure];
      }
      throw new AggregateError(
        [error, ...cleanup],
        'Truncation failed and output was reset',
        { cause: error },
      );
    }
  }
  function dispose() {
    if (disposed) return stats();
    disposed = true;
    context.removeEventListener('statechange', stateChanged);
    return clear();
  }
  function stateChanged() {
    if (context.state === 'closed') {
      try {
        dispose();
      } catch {}
    }
  }
  function timing(plan) {
    available();
    const time = now();
    if (plan.prerollStartTime < time)
      throw new RangeError('Output window preroll starts in the past');
    if (plan.outputEndFrame / outputRate - time > budget.maxAheadSeconds)
      throw new RangeError(
        'Output window exceeds the forward scheduling limit',
      );
    if (
      lastOutputEndFrame !== null &&
      plan.outputStartFrame < lastOutputEndFrame
    )
      throw new RangeError(
        'Output windows must be ordered and non-overlapping',
      );
    if (
      entries.size * 2 + 2 > budget.maxNodes ||
      bufferBytes + plan.bufferBytes > budget.maxBufferBytes
    )
      throw new RangeError('Output resource budget exceeded');
  }
  function schedule(input) {
    available();
    const plan = readPcm(input, outputRate);
    const integerSourceStart = Math.floor(plan.sourceStartFrame);
    plan.prerollStartTime =
      plan.outputStartFrame / outputRate -
      (plan.sourceStartFrame - integerSourceStart) /
        (plan.intervals[0].rate * plan.sampleRate);
    timing(plan);
    const epoch = generation;
    const buffer = context.createBuffer(
      2,
      plan.bufferEndFrame - plan.bufferStartFrame,
      plan.sampleRate,
    );
    for (let channel = 0; channel < 2; channel++) {
      buffer.copyToChannel(
        input.channels[channel].subarray(
          plan.copyOffset,
          plan.copyOffset + buffer.length,
        ),
        channel,
      );
      if (!buffer.getChannelData(channel).every(Number.isFinite))
        throw new RangeError('Copied PCM contains nonfinite samples');
    }
    timing(plan);
    if (epoch !== generation)
      throw new Error('Output generation changed during PCM copy');
    let entry;
    try {
      const node = context.createBufferSource();
      entry = own(node, plan);
      const gain = context.createGain();
      entry.gain = gain;
      node.buffer = buffer;
      node.playbackRate.value = plan.intervals[0].rate;
      for (const interval of plan.intervals) {
        if (interval.outputFrame >= plan.outputEndFrame) break;
        node.playbackRate.setValueAtTime(
          interval.rate,
          Math.max(0, (interval.outputFrame - 0.5) / outputRate),
        );
      }
      gain.gain.automationRate = 'k-rate';
      gain.gain.value = 0;
      gain.gain.setValueAtTime(
        1,
        Math.max(0, (plan.outputStartFrame - 0.5) / outputRate),
      );
      node.addEventListener('ended', entry.onEnded);
      node.connect(gain);
      gain.connect(destination);
      available();
      if (epoch !== generation || plan.prerollStartTime < now())
        throw new Error('Output window became stale during scheduling');
      node.start(
        plan.prerollStartTime,
        (integerSourceStart - plan.bufferStartFrame) / plan.sampleRate,
      );
      entry.started = true;
      node.stop(plan.outputEndFrame / outputRate);
      if (epoch !== generation || disposed)
        throw new Error('Output generation changed during scheduling');
      lastOutputEndFrame = plan.outputEndFrame;
      return Object.freeze({
        generation,
        outputStartFrame: plan.outputStartFrame,
        outputEndFrame: plan.outputEndFrame,
        sourceStartFrame: plan.sourceStartFrame,
        sourceEndFrame: plan.sourceEndFrame,
        bufferStartFrame: plan.bufferStartFrame,
        bufferEndFrame: plan.bufferEndFrame,
        prerollStartTime: plan.prerollStartTime,
      });
    } catch (error) {
      const cleanup = entry ? release(entry, true) : [];
      if (cleanup.length)
        throw new AggregateError(
          [error, ...cleanup],
          'Scheduling and cleanup failed',
          { cause: error },
        );
      throw error;
    }
  }
  available();
  now();
  context.addEventListener('statechange', stateChanged);
  return Object.freeze({ schedule, truncate, reset, dispose, stats });
}
