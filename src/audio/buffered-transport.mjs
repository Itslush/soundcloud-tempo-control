import { createRateWindow } from './rate-clock.mjs';
import { createNaturalOutput } from './natural-output.mjs';
import { createTransportLifecycle } from './transport-lifecycle.mjs';

const QUANTUM = 128;
const PADDING = 128;
const LEAD_SECONDS = 0.05;
const LOOKAHEAD_SECONDS = 0.75;
const WINDOW_SECONDS = 0.25;
const POLL_MS = 25;
const align = (frame) => Math.ceil(frame / QUANTUM) * QUANTUM;
const aborted = () =>
  new DOMException('Playback command superseded', 'AbortError');

function rateFunction(value, position) {
  const rateAt = typeof value === 'function' ? value : () => value;
  const rate = rateAt(position);
  if (!Number.isFinite(rate) || rate < 0.025 || rate > 4)
    throw new RangeError('Playback rate must be between 0.025 and 4');
  return rateAt;
}

function reposition(clock, start) {
  const offset = start - clock.outputStartFrame;
  return Object.freeze({
    ...clock,
    outputStartFrame: start,
    outputEndFrame: clock.outputEndFrame + offset,
    intervals: Object.freeze(
      clock.intervals.map((interval) =>
        Object.freeze({
          ...interval,
          outputFrame: interval.outputFrame + offset,
        }),
      ),
    ),
    sourceAt: (frame) => clock.sourceAt(frame - offset),
    outputAt: (frame) => clock.outputAt(frame) + offset,
  });
}

function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
  });
}

export function createBufferedTransport({
  context,
  provider,
  output,
  destination = context?.destination,
  rate = 1,
  initialPosition = 0,
  initiallyEnded = false,
  onChange = () => {},
  timers = globalThis,
}) {
  if (
    !context ||
    !Number.isInteger(context.sampleRate) ||
    context.sampleRate < 8000 ||
    context.sampleRate > 384000 ||
    typeof context.addEventListener !== 'function' ||
    typeof context.removeEventListener !== 'function' ||
    typeof context.resume !== 'function'
  )
    throw new TypeError('An audio context is required');
  if (
    !provider ||
    ['info', 'acquire', 'reset', 'dispose'].some(
      (key) => typeof provider[key] !== 'function',
    )
  )
    throw new TypeError('A bounded PCM provider is required');
  if (
    typeof onChange !== 'function' ||
    !timers ||
    typeof timers.setTimeout !== 'function' ||
    typeof timers.clearTimeout !== 'function'
  )
    throw new TypeError('Invalid transport callbacks');
  if (
    !Number.isFinite(initialPosition) ||
    initialPosition < 0 ||
    initialPosition >= 86400 ||
    typeof initiallyEnded !== 'boolean'
  )
    throw new TypeError('Invalid initial playback state');
  let rateAt = rateFunction(rate, initialPosition);
  const renderer = output ?? createNaturalOutput({ context, destination });
  if (
    ['schedule', 'truncate', 'reset', 'dispose'].some(
      (key) => typeof renderer[key] !== 'function',
    )
  )
    throw new TypeError('A resource-owning output renderer is required');
  const outputRate = context.sampleRate;
  const frameCount =
    Math.floor((outputRate * WINDOW_SECONDS) / QUANTUM) * QUANTUM;
  let sourceRate = null;
  let durationHint = null;
  let totalSourceFrames;
  let anchorSeconds = initialPosition;
  let sourceFrame = 0;
  let windows = [];
  let pendingStart = null;
  const lifecycle = createTransportLifecycle();
  let ended = initiallyEnded;
  let failure = null;
  let observerErrors = 0;
  let epoch = 0;
  let playGeneration = 0;
  let controller = new AbortController();
  let worker = null;
  let completedEpoch = -1;
  let renderGeneration = 0;
  let rendererInitialized = false;
  let outputBarrier = Promise.resolve();
  let pendingRate = null;
  let unsubscribeFailure;
  let timer = null;
  let resetPending = false;
  let ready = Promise.resolve();
  let disposing = null;

  function hasWork() {
    return lifecycle.wanted || resetPending || pendingRate !== null;
  }

  function leadSeconds() {
    const lead = renderer.minimumLeadSeconds ?? LEAD_SECONDS;
    if (!Number.isFinite(lead) || lead < 0 || lead > 2)
      throw new RangeError('Invalid output scheduling lead');
    return Math.max(LEAD_SECONDS, lead);
  }

  function pcmRange(clock) {
    const range = renderer.requiredPcmRange?.(clock) ?? {
      startFrame: Math.max(0, Math.floor(clock.sourceStartFrame) - PADDING),
      endFrame: Math.ceil(clock.sourceEndFrame) + PADDING,
    };
    if (
      !Number.isSafeInteger(range.startFrame) ||
      !Number.isSafeInteger(range.endFrame) ||
      range.startFrame < 0 ||
      range.startFrame > Math.floor(clock.sourceStartFrame) ||
      range.endFrame < Math.ceil(clock.sourceEndFrame)
    )
      throw new RangeError('Invalid output PCM range');
    return range;
  }

  function resetOutput() {
    const revision = ++renderGeneration;
    outputBarrier = Promise.resolve(renderer.reset());
    outputBarrier.catch((error) => {
      if (!lifecycle.disposed && revision === renderGeneration)
        fail(error, false);
    });
  }

  function nowFrame() {
    if (!Number.isFinite(context.currentTime) || context.currentTime < 0)
      throw new RangeError('Invalid audio context time');
    return context.currentTime * outputRate;
  }

  function available() {
    if (lifecycle.disposed) throw new Error('Buffered transport is disposed');
    if (context.state === 'closed') throw new Error('Audio context is closed');
  }

  function positionAt(frame) {
    let position = sourceFrame;
    for (const window of windows) {
      if (frame < window.outputStartFrame) return position;
      if (frame < window.outputEndFrame) return window.clock.sourceAt(frame);
      position = window.sourceEndFrame;
    }
    return position;
  }

  function prune() {
    const frame = nowFrame();
    while (windows.length && windows[0].outputEndFrame <= frame)
      sourceFrame = windows.shift().sourceEndFrame;
    if (
      lifecycle.wanted &&
      totalSourceFrames !== undefined &&
      sourceFrame >= totalSourceFrames &&
      !windows.length
    ) {
      sourceFrame = totalSourceFrames;
      lifecycle.stop();
      ended = true;
      stopTimer();
    }
  }

  function snapshot() {
    prune();
    const frame = nowFrame();
    const position = positionAt(frame);
    const activeWindow = windows.find(
      (window) =>
        window.outputStartFrame <= frame && frame < window.outputEndFrame,
    );
    const active = Boolean(activeWindow);
    lifecycle.render(active && context.state === 'running');
    const renderedRate = active
      ? activeWindow.clock.intervals[
          Math.floor((frame - activeWindow.outputStartFrame) / QUANTUM)
        ].rate
      : null;
    let state = 'paused';
    if (lifecycle.disposed) state = 'disposed';
    else if (failure) state = 'error';
    else if (ended) state = 'ended';
    else if (lifecycle.wanted && context.state !== 'running')
      state = 'suspended';
    else if (lifecycle.wanted) state = active ? 'playing' : 'buffering';
    return Object.freeze({
      state,
      generation: epoch,
      position: sourceRate ? position / sourceRate : anchorSeconds,
      sourceFrame: sourceRate ? position : null,
      sampleRate: sourceRate,
      duration:
        totalSourceFrames === undefined ? null : totalSourceFrames / sourceRate,
      durationHint,
      lifecycle: lifecycle.phase,
      paused: !lifecycle.wanted,
      ended,
      error: failure,
      scheduledWindows: windows.length,
      renderedRate,
      scheduledAheadSeconds: Math.max(
        0,
        ((windows.at(-1)?.outputEndFrame ?? frame) - frame) / outputRate,
      ),
      observerErrors,
    });
  }

  function notify() {
    const state = snapshot();
    try {
      onChange(state);
    } catch {
      observerErrors++;
    }
    return state;
  }

  function stopTimer() {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  function armTimer() {
    if (
      timer !== null ||
      lifecycle.disposed ||
      !lifecycle.wanted ||
      context.state !== 'running'
    )
      return;
    timer = timers.setTimeout(() => {
      timer = null;
      notify();
      void kick();
    }, POLL_MS);
  }

  function invalidate() {
    epoch++;
    controller.abort();
    controller = new AbortController();
    stopTimer();
  }

  function fail(error, reset = true) {
    if (lifecycle.disposed) return;
    sourceFrame = positionAt(nowFrame());
    lifecycle.stop();
    failure = error;
    invalidate();
    windows = [];
    pendingStart = null;
    try {
      if (reset) resetOutput();
      else renderGeneration++;
    } catch (cleanup) {
      failure = new AggregateError([error, cleanup], 'Playback cleanup failed');
    }
    notify();
  }

  async function initialize(signal) {
    if (signal.aborted) throw aborted();
    if (!sourceRate) {
      const info = await provider.info({ signal });
      if (signal.aborted) throw aborted();
      if (
        !info ||
        !Number.isInteger(info.sampleRate) ||
        info.sampleRate < 8000 ||
        info.sampleRate > 384000 ||
        info.channels !== 2
      )
        throw new Error('Unsupported decoded audio format');
      acceptEnd(info.totalSourceFrames);
      sourceRate = info.sampleRate;
      sourceFrame = anchorSeconds * sourceRate;
      durationHint =
        Number.isFinite(info.durationHint) && info.durationHint >= 0
          ? info.durationHint
          : null;
    }
    if (rendererInitialized) return;
    await renderer.initialize?.({ sourceSampleRate: sourceRate, signal });
    if (signal.aborted) throw aborted();
    leadSeconds();
    rendererInitialized = true;
  }

  function acceptEnd(value) {
    if (value === undefined) return;
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (totalSourceFrames !== undefined && value !== totalSourceFrames)
    )
      throw new Error('Invalid or changing decoded audio end');
    totalSourceFrames = value;
  }

  async function fill(signal) {
    if (resetPending) {
      await provider.reset();
      resetPending = false;
    }
    if (signal.aborted) return;
    await untilAborted(outputBarrier, signal);
    if (signal.aborted) return;
    lifecycle.settled();
    if (pendingRate) await applyRate();
    if (!lifecycle.wanted || signal.aborted) return;
    await untilAborted(ready, signal);
    await initialize(signal);
    while (!signal.aborted && lifecycle.wanted && context.state === 'running') {
      prune();
      const last = windows.at(-1);
      const sourceStart = last?.sourceEndFrame ?? sourceFrame;
      if (totalSourceFrames !== undefined && sourceStart >= totalSourceFrames) {
        if (!windows.length) sourceFrame = totalSourceFrames;
        prune();
        break;
      }
      const current = nowFrame();
      if (
        last &&
        last.outputEndFrame >= current + LOOKAHEAD_SECONDS * outputRate
      )
        break;
      if (windows.length >= 4) break;
      let clock = createRateWindow({
        outputStartFrame:
          pendingStart ??
          last?.outputEndFrame ??
          align(current + leadSeconds() * outputRate),
        sourceStartFrame: sourceStart,
        sourceSampleRate: sourceRate,
        outputSampleRate: outputRate,
        frameCount,
        rateAt,
      });
      let lease;
      let generation;
      try {
        const range = pcmRange(clock);
        lease = await provider.acquire(range.startFrame, range.endFrame, {
          signal,
        });
        if (signal.aborted) throw aborted();
        acceptEnd(lease.totalSourceFrames);
        if (
          totalSourceFrames !== undefined &&
          sourceStart >= totalSourceFrames
        ) {
          if (!windows.length) sourceFrame = totalSourceFrames;
          break;
        }
        const currentFrame = nowFrame();
        const minimumLead = Math.max(
          2 * QUANTUM + outputRate / (0.025 * sourceRate),
          (renderer.minimumLeadSeconds ?? 0) * outputRate,
        );
        if (clock.outputStartFrame < currentFrame + minimumLead)
          clock = reposition(
            clock,
            align(currentFrame + leadSeconds() * outputRate),
          );
        generation = renderGeneration;
        const scheduled = await renderer.schedule({ ...lease, clock });
        if (lifecycle.disposed || generation !== renderGeneration)
          throw aborted();
        if (
          scheduled.sourceStartFrame !== sourceStart ||
          !Number.isFinite(scheduled.sourceEndFrame) ||
          scheduled.sourceEndFrame <= sourceStart ||
          scheduled.outputStartFrame !== clock.outputStartFrame ||
          scheduled.outputEndFrame > clock.outputEndFrame ||
          scheduled.outputEndFrame <= clock.outputStartFrame ||
          Math.abs(
            scheduled.sourceEndFrame - clock.sourceAt(scheduled.outputEndFrame),
          ) > 0.000001
        )
          throw new Error('Output renderer broke playback continuity');
        windows.push({ ...scheduled, clock });
        pendingStart = null;
      } catch (error) {
        if (
          generation !== undefined &&
          generation === renderGeneration &&
          !lifecycle.disposed
        )
          fail(error);
        throw error;
      } finally {
        lease?.release();
      }
    }
  }

  function kick() {
    if (worker)
      return worker.then(() => {
        if (
          !lifecycle.disposed &&
          !failure &&
          hasWork() &&
          completedEpoch !== epoch
        )
          return kick();
        return snapshot();
      });
    if (!hasWork() || lifecycle.disposed || failure)
      return Promise.resolve(snapshot());
    worker = (async () => {
      let revision;
      let state;
      do {
        revision = epoch;
        try {
          await fill(controller.signal);
        } catch (error) {
          if (revision === epoch && !lifecycle.disposed) fail(error);
        }
        state = notify();
      } while (
        revision !== epoch &&
        hasWork() &&
        !lifecycle.disposed &&
        !failure
      );
      completedEpoch = revision;
      return state;
    })().finally(() => {
      worker = null;
      armTimer();
    });
    return worker;
  }

  function play() {
    available();
    if (!lifecycle.wanted) {
      const rewind = ended;
      invalidate();
      playGeneration++;
      lifecycle.play();
      failure = null;
      ended = false;
      try {
        ready =
          context.state === 'running'
            ? Promise.resolve()
            : Promise.resolve(context.resume());
      } catch (error) {
        ended = rewind;
        fail(error);
        return Promise.reject(error);
      }
      ready.catch(() => {});
      if (rewind) seek(0);
      else notify();
    }
    const generation = playGeneration;
    return kick().then((state) => {
      if (generation !== playGeneration) throw aborted();
      if (state.error) throw state.error;
      if (state.paused && !state.ended) throw aborted();
      return state;
    });
  }

  function pause() {
    available();
    sourceFrame = positionAt(nowFrame());
    lifecycle.stop();
    playGeneration++;
    invalidate();
    windows = [];
    pendingStart = null;
    try {
      resetOutput();
    } catch (error) {
      failure = error;
    }
    return notify();
  }

  function seek(seconds) {
    available();
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 86400)
      throw new RangeError('Seek position must be within 24 hours');
    invalidate();
    lifecycle.seek();
    anchorSeconds = seconds;
    sourceFrame = sourceRate ? seconds * sourceRate : 0;
    if (totalSourceFrames !== undefined)
      sourceFrame = Math.min(sourceFrame, totalSourceFrames);
    windows = [];
    resetPending = true;
    pendingStart = null;
    ended = false;
    failure = null;
    try {
      resetOutput();
    } catch (error) {
      fail(error);
    }
    notify();
    return kick();
  }

  function setRate(value) {
    available();
    pendingRate = rateFunction(value, snapshot().position);
    invalidate();
    notify();
    return kick();
  }

  async function applyRate() {
    const next = pendingRate;
    pendingRate = null;
    const frame = nowFrame();
    let cut = align(frame + leadSeconds() * outputRate);
    const retained = windows.find((window) => cut <= window.outputEndFrame);
    if (retained) cut = Math.max(cut, retained.outputStartFrame);
    const generation = renderGeneration;
    rateAt = next;
    if (retained) {
      pendingStart = cut;
      const position = retained.clock.sourceAt(cut);
      windows = windows.filter((window) => window.outputStartFrame < cut);
      const last = windows.at(-1);
      if (last && last.outputEndFrame > cut) {
        last.sourceEndFrame = position;
        last.outputEndFrame = cut;
      }
      try {
        await renderer.truncate(cut);
      } catch (error) {
        if (generation === renderGeneration && !lifecycle.disposed) fail(error);
        throw error;
      }
    }
  }

  function stateChanged() {
    if (lifecycle.disposed) return;
    if (context.state === 'closed') {
      fail(new Error('Audio context is closed'));
      void dispose().catch((error) => {
        failure = error;
        notify();
      });
      return;
    }
    stopTimer();
    notify();
    if (lifecycle.wanted && context.state === 'running') void kick();
  }

  function dispose() {
    if (disposing) return disposing;
    sourceFrame = positionAt(nowFrame());
    lifecycle.dispose();
    renderGeneration++;
    playGeneration++;
    invalidate();
    windows = [];
    pendingStart = null;
    context.removeEventListener('statechange', stateChanged);
    const errors = [];
    let outputDisposal;
    try {
      unsubscribeFailure?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      outputDisposal = Promise.resolve(renderer.dispose());
      outputDisposal.catch(() => {});
    } catch (error) {
      errors.push(error);
    }
    disposing = (async () => {
      await worker;
      try {
        await provider.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await outputDisposal;
      } catch (error) {
        errors.push(error);
      }
      notify();
      if (errors.length)
        throw new AggregateError(errors, 'Transport disposal failed');
      return snapshot();
    })();
    return disposing;
  }

  available();
  nowFrame();
  context.addEventListener('statechange', stateChanged);
  unsubscribeFailure = renderer.subscribeFailure?.((error) =>
    fail(error, false),
  );
  return Object.freeze({ play, pause, seek, setRate, snapshot, dispose });
}
