const PROCESSOR = 'soundcloud-preserve-buffered-v1';
const MODULES = new WeakMap();
const QUANTUM = 128;
const abortError = () =>
  new DOMException('Preserved output operation cancelled', 'AbortError');

function listenUntil(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || abortError());
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createPreserveOutput({
  context,
  destination,
  moduleSource,
  limits = {},
}) {
  if (
    !context?.audioWorklet ||
    !destination ||
    destination.context !== context ||
    typeof context.createGain !== 'function' ||
    !Number.isInteger(context.sampleRate) ||
    context.sampleRate < 8000 ||
    context.sampleRate > 192000
  )
    throw new TypeError(
      'A supported audio context and destination are required',
    );
  if (typeof moduleSource !== 'string' || !moduleSource.length)
    throw new TypeError('A compiled preserved worklet source is required');
  const budget = {
    maxBufferBytes: 8 * 1024 * 1024,
    maxWindows: 8,
    maxAheadSeconds: 4,
    ...limits,
  };
  if (
    Object.keys(limits).some(
      (key) =>
        !['maxBufferBytes', 'maxWindows', 'maxAheadSeconds'].includes(key),
    ) ||
    !Number.isSafeInteger(budget.maxBufferBytes) ||
    budget.maxBufferBytes < 8192 ||
    !Number.isSafeInteger(budget.maxWindows) ||
    budget.maxWindows < 1 ||
    budget.maxWindows > 32 ||
    !Number.isFinite(budget.maxAheadSeconds) ||
    budget.maxAheadSeconds <= 0
  )
    throw new RangeError('Invalid preserved output limits');
  const gate = context.createGain();
  gate.gain.value = 0;
  gate.connect(destination);
  const failures = new Set();
  const requests = new Map();
  let node,
    sourceRate,
    initialization,
    cachedEnd,
    lastEnd,
    totalFrames,
    disposing;
  let readyResolve, readyReject, initTimer;
  let generation = 0,
    nextId = 0;
  let disposed = false,
    operation = false;
  let failure = null;
  let resetBarrier = Promise.resolve();
  let processorStats = {
    windows: 0,
    buffers: 0,
    bufferBytes: 0,
    peakBufferBytes: 0,
  };

  function mute() {
    gate.gain.cancelScheduledValues(0);
    gate.gain.value = 0;
  }

  function fail(error) {
    if (failure || disposed) return;
    failure = error;
    mute();
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    requests.clear();
    readyReject?.(error);
    for (const callback of failures) {
      try {
        callback(error);
      } catch {}
    }
  }

  function available() {
    if (disposed) throw new Error('Preserved output is disposed');
    if (failure) throw failure;
    if (context.state === 'closed') throw new Error('Audio context is closed');
  }

  function receive(event) {
    const message = event.data;
    if (message.type === 'ready') {
      clearTimeout(initTimer);
      processorStats = message;
      readyResolve(message);
    } else if (message.type === 'failure') fail(new Error(message.message));
    else if (
      message.type === 'stats' &&
      message.value.generation === generation
    )
      processorStats = message.value;
    else if (message.type === 'reply') {
      const request = requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      requests.delete(message.id);
      if (message.generation !== request.generation)
        request.reject(new Error('Preserved reply generation mismatch'));
      else if (message.error) request.reject(new Error(message.error));
      else {
        if (message.generation === generation) processorStats = message.value;
        request.resolve(message.value);
      }
    }
  }

  function post(method, value, transfer = [], revision = generation) {
    if (!node)
      return Promise.reject(new Error('Preserved output is not initialized'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        const error = new Error('Preserved processor response timed out');
        reject(error);
        fail(error);
      }, 2000);
      requests.set(id, { resolve, reject, timer, generation: revision });
      try {
        node.port.postMessage(
          { id, generation: revision, method, value },
          transfer,
        );
      } catch (error) {
        clearTimeout(timer);
        requests.delete(id);
        reject(error);
      }
    });
  }

  async function initialize({ sourceSampleRate, signal } = {}) {
    available();
    if (
      !Number.isInteger(sourceSampleRate) ||
      sourceSampleRate < 8000 ||
      sourceSampleRate > 192000
    )
      throw new RangeError('Unsupported preserved source sample rate');
    if (sourceRate !== undefined && sourceRate !== sourceSampleRate)
      throw new Error(
        'Source sample rate changed without replacing the renderer',
      );
    sourceRate = sourceSampleRate;
    const initialGeneration = generation;
    if (!initialization)
      initialization = (async () => {
        if (!MODULES.has(context)) {
          const loading = (async () => {
            const url = URL.createObjectURL(
              new Blob([moduleSource], { type: 'text/javascript' }),
            );
            try {
              await context.audioWorklet.addModule(url);
            } finally {
              URL.revokeObjectURL(url);
            }
          })();
          MODULES.set(context, loading);
          loading.catch(() => MODULES.delete(context));
        }
        await MODULES.get(context);
        available();
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
          initTimer = setTimeout(
            () =>
              fail(new Error('Preserved processor initialization timed out')),
            3000,
          );
        });
        node = new AudioWorkletNode(context, PROCESSOR, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            sourceSampleRate: sourceRate,
            generation: initialGeneration,
            maxBufferBytes: budget.maxBufferBytes,
            maxWindows: budget.maxWindows,
          },
        });
        node.port.onmessage = receive;
        node.addEventListener('processorerror', processorFailed);
        node.connect(gate);
        await ready;
        return stats();
      })().catch((error) => {
        fail(error);
        throw error;
      });
    return listenUntil(initialization, signal);
  }

  function minimumLead() {
    return (
      (processorStats.outputLatencyFrames ?? 0) / context.sampleRate + 0.06
    );
  }

  function requiredPcmRange(clock) {
    available();
    if (!node || !processorStats.historyFrames)
      throw new Error('Initialize preserved output before requesting PCM');
    if (
      clock.sourceSampleRate !== sourceRate ||
      clock.outputSampleRate !== context.sampleRate
    )
      throw new RangeError('Preserved clock sample rates do not match');
    return Object.freeze({
      startFrame: Math.max(
        0,
        Math.floor(clock.sourceStartFrame) -
          processorStats.outputLatencyFrames -
          QUANTUM,
      ),
      endFrame:
        Math.ceil(clock.sourceEndFrame) +
        processorStats.inputLatencyFrames +
        Math.ceil(
          ((4 * sourceRate) / context.sampleRate) *
            processorStats.outputLatencyFrames,
        ) +
        QUANTUM,
    });
  }

  function readWindow(input) {
    const { clock, sampleRate, pcmStartFrame, channels, totalSourceFrames } =
      input;
    const range = requiredPcmRange(clock);
    if (
      sampleRate !== sourceRate ||
      !Number.isSafeInteger(pcmStartFrame) ||
      pcmStartFrame < 0 ||
      !Array.isArray(channels) ||
      channels.length !== 2 ||
      channels.some((channel) => !(channel instanceof Float32Array)) ||
      !channels[0].length ||
      channels[0].length !== channels[1].length
    )
      throw new TypeError('Invalid preserved stereo PCM lease');
    if (
      totalSourceFrames !== undefined &&
      (!Number.isSafeInteger(totalSourceFrames) ||
        totalSourceFrames <= clock.sourceStartFrame ||
        (totalFrames !== undefined && totalFrames !== totalSourceFrames))
    )
      throw new RangeError('Invalid or changing preserved EOF');
    const end =
      totalSourceFrames === undefined
        ? range.endFrame
        : Math.min(range.endFrame, totalSourceFrames);
    if (
      pcmStartFrame > range.startFrame ||
      pcmStartFrame + channels[0].length < end
    )
      throw new RangeError(
        'PCM lease does not cover preserved history and lookahead',
      );
    const sourceEndFrame =
      totalSourceFrames === undefined
        ? clock.sourceEndFrame
        : Math.min(clock.sourceEndFrame, totalSourceFrames);
    const outputEndFrame =
      sourceEndFrame < clock.sourceEndFrame
        ? clock.outputAt(sourceEndFrame)
        : clock.outputEndFrame;
    return {
      window: {
        outputStartFrame: clock.outputStartFrame,
        outputEndFrame,
        sourceStartFrame: clock.sourceStartFrame,
        sourceEndFrame,
        intervals: clock.intervals.map((interval) => ({ ...interval })),
      },
      range: { startFrame: range.startFrame, endFrame: end },
    };
  }

  async function schedule(input) {
    available();
    if (operation)
      throw new Error('A preserved scheduling operation is already active');
    operation = true;
    const revision = generation;
    try {
      await resetBarrier;
      available();
      if (revision !== generation) throw abortError();
      const { window, range } = readWindow(input);
      const now = context.currentTime * context.sampleRate;
      if (
        window.outputStartFrame <
          now + processorStats.outputLatencyFrames + 2 * QUANTUM ||
        (window.outputEndFrame - now) / context.sampleRate >
          budget.maxAheadSeconds ||
        (lastEnd !== undefined && window.outputStartFrame < lastEnd)
      )
        throw new RangeError(
          'Preserved output timing is outside its scheduling window',
        );
      const start = Math.max(range.startFrame, cachedEnd ?? range.startFrame);
      const length = Math.max(0, range.endFrame - start);
      if (processorStats.bufferBytes + length * 8 > budget.maxBufferBytes)
        throw new RangeError('Preserved PCM byte budget exceeded');
      const channels = length
        ? input.channels.map((channel) =>
            channel.slice(
              start - input.pcmStartFrame,
              start - input.pcmStartFrame + length,
            ),
          )
        : [];
      const result = await post(
        'schedule',
        {
          window,
          pcmStartFrame: start,
          channels,
          totalSourceFrames: input.totalSourceFrames,
        },
        channels.map((channel) => channel.buffer),
      );
      if (revision !== generation) throw abortError();
      available();
      if (
        window.outputStartFrame <
        Math.ceil(context.currentTime * context.sampleRate) + QUANTUM
      )
        throw new Error(
          'Preserved schedule acknowledgement missed its activation deadline',
        );
      cachedEnd = result.bufferEndFrame;
      lastEnd = window.outputEndFrame;
      totalFrames = input.totalSourceFrames;
      const startTime = Math.max(
        0,
        (window.outputStartFrame - 0.5) / context.sampleRate,
      );
      gate.gain.cancelScheduledValues(startTime);
      gate.gain.setValueAtTime(1, startTime);
      gate.gain.setValueAtTime(0, window.outputEndFrame / context.sampleRate);
      return Object.freeze({ generation, ...window, intervals: undefined });
    } catch (error) {
      if (revision === generation) fail(error);
      throw error;
    } finally {
      operation = false;
    }
  }

  async function truncate(outputFrame) {
    available();
    if (operation)
      throw new Error('A preserved scheduling operation is already active');
    if (
      !Number.isSafeInteger(outputFrame) ||
      outputFrame % QUANTUM ||
      outputFrame / context.sampleRate < context.currentTime + minimumLead()
    )
      throw new RangeError(
        'Preserved truncation needs a future latency-safe quantum',
      );
    operation = true;
    const revision = generation;
    try {
      const time = Math.max(0, (outputFrame - 0.5) / context.sampleRate);
      gate.gain.cancelScheduledValues(time);
      gate.gain.setValueAtTime(0, time);
      await post('truncate', outputFrame);
      if (revision !== generation) throw abortError();
      lastEnd = outputFrame;
      return stats();
    } catch (error) {
      if (revision === generation) fail(error);
      throw error;
    } finally {
      operation = false;
    }
  }

  function reset() {
    available();
    generation++;
    mute();
    cachedEnd = undefined;
    lastEnd = undefined;
    totalFrames = undefined;
    const revision = generation;
    resetBarrier = initialization
      ? Promise.all([initialization, resetBarrier])
          .then(() => post('reset', undefined, [], revision))
          .then(() => stats())
      : Promise.resolve(stats());
    resetBarrier.catch((error) => fail(error));
    return resetBarrier;
  }

  function stats() {
    return Object.freeze({
      ...processorStats,
      generation,
      disposed,
      error: failure,
      nodes: disposed ? 0 : node ? 2 : 1,
      pendingRequests: requests.size,
      minimumLeadSeconds: minimumLead(),
      sourceSampleRate: sourceRate,
      outputSampleRate: context.sampleRate,
      sampleRatePitchFactor: sourceRate / context.sampleRate,
    });
  }

  function dispose() {
    if (disposing) return disposing;
    disposed = true;
    mute();
    generation++;
    disposing = (async () => {
      try {
        if (node) {
          await resetBarrier.catch(() => {});
          await post('dispose');
        }
      } finally {
        clearTimeout(initTimer);
        readyReject?.(abortError());
        for (const request of requests.values()) {
          clearTimeout(request.timer);
          request.reject(abortError());
        }
        requests.clear();
        if (node) {
          node.removeEventListener('processorerror', processorFailed);
          node.disconnect();
          node.port.onmessage = null;
          node.port.close();
        }
        gate.disconnect();
        context.removeEventListener('statechange', stateChanged);
        failures.clear();
        moduleSource = null;
      }
      return stats();
    })();
    return disposing;
  }

  function processorFailed() {
    fail(new Error('Preserved audio worklet failed'));
  }
  function stateChanged() {
    if (context.state === 'closed') fail(new Error('Audio context is closed'));
  }
  context.addEventListener('statechange', stateChanged);
  return Object.freeze({
    initialize,
    requiredPcmRange,
    get minimumLeadSeconds() {
      return minimumLead();
    },
    schedule,
    truncate,
    reset,
    dispose,
    stats,
    subscribeFailure(callback) {
      if (typeof callback !== 'function')
        throw new TypeError('A failure callback is required');
      failures.add(callback);
      if (failure) callback(failure);
      return () => failures.delete(callback);
    },
  });
}
