export function createWasmAudio({
  audioModules,
  outputLevel,
  createStretchNode,
  preservesKey,
  readKeyShift = () => 0,
  readUseWasm,
  references,
  updateAll,
  apply,
  discover,
  onGraphReady,
}) {
  if (!window.AudioContext || !window.AudioNode)
    return {
      sync: () => false,
      active: () => false,
      hasGraph: () => false,
      crossfadeReady: () => false,
      acquireBuffered() {
        throw new Error('Web Audio is unavailable.');
      },
      label: () =>
        preservesKey()
          ? 'Browser fallback · Web Audio is unavailable.'
          : 'Natural pitch follows speed.',
    };
  const routes = new WeakMap();
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  const create = AudioContext.prototype.createMediaElementSource;
  const states = new WeakMap();

  function gains(state, wet) {
    if (state.active === wet) return;
    const starting = wet && !state.active;
    state.active = wet;
    state.wet.gain.cancelScheduledValues(state.source.context.currentTime);
    state.dry.gain.value = wet ? 0 : 1;
    if (starting) {
      const now = state.source.context.currentTime;
      state.input.gain.cancelScheduledValues(now);
      state.input.gain.setValueAtTime(0, now);
      state.input.gain.setValueAtTime(1, now + state.latency);
      state.wet.gain.setValueAtTime(0, now);
      state.wet.gain.setValueAtTime(0, now + state.latency * 2);
      state.wet.gain.linearRampToValueAtTime(1, now + state.latency * 2 + 0.01);
    } else state.wet.gain.value = wet ? 1 : 0;
  }

  function clear(state) {
    const connected = state.connected;
    state.epoch++;
    gains(state, false);
    state.input.gain.cancelScheduledValues(state.source.context.currentTime);
    state.input.gain.value = 0;
    state.needsReset = true;
    state.applied = null;
    if (state.node && connected) {
      try {
        state.input.disconnect(state.node);
      } catch {}
      state.node.disconnect();
      state.connected = false;
    }
    if (!connected || state.failed || state.stopping) return;
    state.stopping = stop(state.node)
      .catch((error) => fail(state, error))
      .finally(() => {
        state.stopping = null;
      });
  }

  async function stop(node) {
    await timed(node.schedule({ active: false }));
  }

  function retire(state) {
    state.failed = true;
    clear(state);
    if (!state.node) return;
    state.node.disconnect();
    state.node.port.close();
    state.node = null;
  }

  function fail(state, error) {
    if (state.failed) return;
    retire(state);
    console.warn(
      '[SoundCloud Tempo] WASM unavailable; browser fallback.',
      error,
    );
    updateAll();
  }

  function ready(state, epoch) {
    const audio = state.audio.deref();
    return (
      epoch === state.epoch &&
      !state.buffered &&
      !state.failed &&
      state.wanted &&
      audio &&
      !audio.paused &&
      !audio.seeking &&
      state.source.context.state !== 'closed'
    );
  }

  async function timed(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('WASM processor timed out')),
            6000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function prepare(state) {
    if (state.loading || state.failed || state.buffered) return;
    state.loading = true;
    const epoch = state.epoch;
    const speed = state.speed;
    const semitones =
      readKeyShift() - (preservesKey() ? 12 * Math.log2(speed) : 0);
    try {
      if (!state.node) {
        const pending = createStretchNode(state.source.context, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        pending.then(
          (node) => {
            if (state.failed || state.source.context.state === 'closed') {
              node.disconnect();
              node.port.close();
              return;
            }
            state.node = node;
            const reference = new WeakRef(state);
            node.addEventListener('processorerror', () => {
              const current = reference.deref();
              if (current?.node === node)
                fail(current, new Error('WASM processor stopped'));
            });
          },
          () => {},
        );
        await timed(pending);
      }
      if (!ready(state, epoch)) return;
      if (state.stopping) await state.stopping;
      if (!ready(state, epoch)) return;
      const node = state.node;
      if (state.needsReset) {
        const sampleRate = state.source.context.sampleRate;
        await timed(
          node.configure({
            blockMs: (Math.floor(sampleRate * 0.12) / sampleRate) * 1000,
            intervalMs: (Math.floor(sampleRate * 0.03) / sampleRate) * 1000,
            splitComputation: false,
          }),
        );
        state.latency = await timed(node.latency());
        if (!ready(state, epoch)) return;
        if (!Number.isFinite(state.latency) || state.latency < 0)
          throw new Error('WASM processor returned invalid latency');
        state.needsReset = false;
        state.input.connect(node);
        state.connected = true;
        node.connect(state.wet);
      }
      await timed(node.schedule({ active: true, semitones }));
      if (
        !ready(state, epoch) ||
        speed !== state.speed ||
        semitones !== state.semitones
      )
        return;
      state.applied = semitones;
      gains(state, true);
    } catch (error) {
      fail(state, error);
    } finally {
      state.loading = false;
      updateAll();
    }
  }

  function sync(audio, enabled, speed) {
    const state = states.get(audio);
    if (!state) return false;
    const changed = state.wanted !== enabled;
    state.wanted = enabled;
    state.speed = speed;
    state.semitones =
      readKeyShift() - (preservesKey() ? 12 * Math.log2(speed) : 0);
    if (state.buffered) return false;
    if (!enabled || audio.seeking || audio.paused) {
      if (changed || state.connected || state.active) clear(state);
      return false;
    }
    if (state.failed || state.source.context.state === 'closed') return false;
    if (state.needsReset || state.applied !== state.semitones) prepare(state);
    return state.active;
  }

  function bufferedHooks(state, name, command) {
    const owner = state.buffered;
    if (!owner)
      throw new DOMException('Buffered ownership ended', 'AbortError');
    if (name === 'restoreNative') clear(state);
    return owner.hooks[name](command);
  }

  function makeGate(state) {
    const context = state.source.context;
    const nativeMix = context.createGain();
    const reference = state.audio;
    const audio = () => {
      const current = reference.deref();
      if (!current) throw new Error('Audio element is unavailable.');
      return current;
    };
    let gate;
    try {
      gate = audioModules.createPlaybackGate({
        context,
        nativeInput: nativeMix,
        destination: state.output,
        levels: {
          read: () => outputLevel.readLevel(audio()),
          subscribe: (callback) =>
            outputLevel.subscribeLevel(audio(), callback),
        },
        parkNative: (command) => bufferedHooks(state, 'parkNative', command),
        restoreNative: (command) =>
          bufferedHooks(state, 'restoreNative', command),
      });
      return { gate, nativeMix };
    } catch (error) {
      try {
        disconnect.call(nativeMix);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Buffered route allocation failed',
        );
      }
      throw error;
    }
  }

  function moveNative(state, nativeMix) {
    const changed = [];
    const previous = state.fade || state.output;
    try {
      for (const node of [state.dry, state.wet]) {
        changed.push({ node, removed: false });
        connect.call(node, nativeMix);
      }
      for (const entry of changed) {
        entry.removed = true;
        disconnect.call(entry.node, previous);
      }
    } catch (error) {
      const errors = [error];
      for (const { node, removed } of changed) {
        try {
          disconnect.call(node, nativeMix);
        } catch (cleanup) {
          errors.push(cleanup);
        }
        if (!removed) continue;
        try {
          connect.call(node, previous);
        } catch (cleanup) {
          errors.push(cleanup);
        }
      }
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          'Native audio route restoration failed',
        );
      throw error;
    }
  }

  function acquireBuffered(audio, hooks) {
    const state = states.get(audio);
    if (!state || state.source.context.state === 'closed')
      throw new Error('An active native audio graph is required.');
    if (
      !hooks ||
      typeof hooks.parkNative !== 'function' ||
      typeof hooks.restoreNative !== 'function'
    )
      throw new TypeError('Native ownership hooks are required.');
    if (state.buffered)
      throw new Error('Buffered playback already has an owner.');
    const owner = {
      hooks: {
        parkNative: hooks.parkNative,
        restoreNative: hooks.restoreNative,
      },
      releasePromise: null,
    };
    state.buffered = owner;
    let created;
    let lease;
    try {
      if (!state.gate) created = makeGate(state);
      const gate = state.gate || created.gate;
      lease = gate.acquire();
      clear(state);
      if (created) {
        moveNative(state, created.nativeMix);
        state.gate = created.gate;
        state.nativeMix = created.nativeMix;
      }
    } catch (error) {
      state.buffered = null;
      try {
        created?.gate.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Buffered route allocation failed',
        );
      }
      throw error;
    }
    return Object.freeze({
      context: state.source.context,
      input: lease.input,
      ready: lease.ready,
      release(position, options) {
        if (owner.releasePromise) return owner.releasePromise;
        const result = lease.release(position, options);
        owner.releasePromise = result
          .then((snapshot) => {
            if (state.buffered === owner) state.buffered = null;
            return snapshot;
          })
          .catch((error) => {
            owner.releasePromise = null;
            throw error;
          });
        owner.releasePromise.catch(() => {});
        return owner.releasePromise;
      },
    });
  }

  function crossfadeReady(audio, { preserve, shift, rate }) {
    const state = states.get(audio);
    return Boolean(
      state &&
        state.source.context.state === 'running' &&
        !state.buffered &&
        !state.gate &&
        !state.loading &&
        !state.stopping &&
        (!(shift || (preserve && rate !== 1)) || state.active),
    );
  }

  function fadeNode(state) {
    if (!state.fade) {
      const fade = state.source.context.createGain();
      connect.call(fade, state.output);
      try {
        moveNative(state, fade);
      } catch (error) {
        disconnect.call(fade);
        throw error;
      }
      state.fade = fade;
    }
    return state.fade;
  }

  async function prepareIncoming(audio, buffer, settings, { signal }) {
    signal.throwIfAborted();
    const { rate, preserve, shift } = settings;
    if (
      !Number.isFinite(rate) ||
      rate < 0.25 ||
      rate > 4 ||
      !Number.isFinite(shift) ||
      Math.abs(shift) > 24
    )
      throw new Error('Unsupported incoming tempo or pitch.');
    const sampleRate = states.get(audio).source.context.sampleRate;
    const duration = buffer.duration / rate;
    const frames = Math.ceil((duration + 1) * sampleRate);
    if (frames * 8 > 32 * 1024 * 1024)
      throw new Error('The incoming crossfade buffer is too large.');
    const offline = new OfflineAudioContext(2, frames, sampleRate);
    const input = offline.createBufferSource();
    input.buffer = buffer;
    input.playbackRate.value = rate;
    let processor;
    let latency = 0;
    try {
      const semitones = shift - (preserve ? 12 * Math.log2(rate) : 0);
      if (semitones) {
        processor = await timed(
          createStretchNode(offline, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          }),
        );
        await timed(
          processor.configure({
            blockMs: 120,
            intervalMs: 30,
            splitComputation: false,
          }),
        );
        latency = await timed(processor.latency());
        if (!Number.isFinite(latency) || latency < 0 || latency > 1)
          throw new Error('Unsupported pitch processor latency.');
        await timed(processor.schedule({ active: true, semitones }));
        input.connect(processor).connect(offline.destination);
      } else input.connect(offline.destination);
      signal.throwIfAborted();
      input.start();
      const rendered = await timed(offline.startRendering());
      signal.throwIfAborted();
      const result = offline.createBuffer(
        2,
        Math.floor(duration * sampleRate),
        sampleRate,
      );
      const start = Math.round(latency * sampleRate);
      for (let channel = 0; channel < 2; channel++)
        result.copyToChannel(
          rendered
            .getChannelData(channel)
            .subarray(start, start + result.length),
          channel,
        );
      return result;
    } finally {
      input.disconnect();
      processor?.disconnect();
      processor?.port.close();
    }
  }

  function beginCrossfade(audio, buffer, offset, rate, seconds, opening) {
    const state = states.get(audio);
    if (
      !state ||
      state.buffered ||
      state.gate ||
      state.loading ||
      state.stopping ||
      state.source.context.state !== 'running' ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      !Number.isFinite(rate) ||
      rate < 0.25 ||
      rate > 4 ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 10 ||
      !Number.isFinite(opening?.duration) ||
      opening.duration < seconds ||
      opening.duration > 19
    )
      throw new Error(
        'The player audio connection is not ready for crossfade.',
      );
    const context = state.source.context;
    const nativeFade = fadeNode(state);
    const tail = context.createBufferSource();
    const level = context.createGain();
    const envelope = context.createGain();
    const head = context.createBufferSource();
    const headEnvelope = context.createGain();
    const headLevel = context.createGain();
    let processor = null;
    let unsubscribe;
    let levelAudio;
    let closed = false;
    const incoming = new Set([state]);
    const now = context.currentTime;
    function followLevel(target) {
      if (target === levelAudio) return;
      unsubscribe?.();
      unsubscribe = outputLevel.subscribeLevel(
        target,
        ({ volume, muted, outputDb }) => {
          level.gain.value = muted ? 0 : volume * 10 ** (outputDb / 20);
          headLevel.gain.value = level.gain.value;
        },
      );
      levelAudio = target;
    }
    function restore(target) {
      if (!target.fade || target.source.context.state === 'closed') return;
      target.fade.gain.cancelScheduledValues(target.source.context.currentTime);
      target.fade.gain.setValueAtTime(1, target.source.context.currentTime);
    }
    function dispose() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      try {
        tail.stop();
      } catch {}
      try {
        head.stop();
      } catch {}
      for (const node of [
        tail,
        head,
        headEnvelope,
        headLevel,
        level,
        envelope,
        processor,
      ]) {
        try {
          if (node) disconnect.call(node);
        } catch {}
      }
      processor?.port.close();
      for (const target of incoming) restore(target);
    }
    try {
      tail.buffer = buffer;
      head.buffer = opening;
      tail.playbackRate.value = rate;
      tail.connect(level);
      envelope.connect(state.output);
      followLevel(audio);
      // Both streams follow the same master volume, without double-applying the outgoing pitch processor.
      head.connect(headEnvelope).connect(headLevel).connect(state.output);
      // Keep the outgoing processor's history while the native player loads a new track.
      if (state.active && state.node) {
        processor = state.node;
        disconnect.call(state.input, processor);
        disconnect.call(processor);
        level.connect(processor);
        processor.connect(envelope);
        processor.addEventListener('processorerror', dispose, { once: true });
        state.node = null;
        state.connected = false;
        state.active = false;
        state.applied = null;
        state.needsReset = true;
        state.wet.gain.cancelScheduledValues(now);
        state.wet.gain.value = 0;
        state.dry.gain.value = 1;
      } else level.connect(envelope);
      nativeFade.gain.cancelScheduledValues(now);
      nativeFade.gain.setValueAtTime(0, now);
      envelope.gain.setValueAtTime(1, now);
      envelope.gain.linearRampToValueAtTime(0, now + seconds);
      headEnvelope.gain.setValueAtTime(0, now);
      headEnvelope.gain.linearRampToValueAtTime(1, now + seconds);
      tail.start(now, offset);
      tail.stop(now + seconds);
      head.start(now);
    } catch (error) {
      dispose();
      throw error;
    }
    return {
      endTime: now + opening.duration,
      overlapEnd: now + seconds,
      startedAt: now,
      context,
      silence(target) {
        const next = states.get(target);
        if (!next || closed) return false;
        followLevel(target);
        if (!incoming.has(next)) {
          fadeNode(next).gain.setValueAtTime(
            0,
            next.source.context.currentTime,
          );
          incoming.add(next);
        }
        return true;
      },
      position() {
        return Math.max(0, context.currentTime - now);
      },
      nativePosition(target) {
        const next = states.get(target);
        return (
          target.currentTime -
          (next?.active ? next.latency * target.playbackRate : 0)
        );
      },
      fadeIn(target, duration = 0.08) {
        if (!this.silence(target)) return false;
        const next = states.get(target);
        const at = next.source.context.currentTime;
        next.fade.gain.cancelScheduledValues(at);
        next.fade.gain.setValueAtTime(0, at);
        next.fade.gain.linearRampToValueAtTime(1, at + duration);
        const time = context.currentTime;
        headEnvelope.gain.cancelScheduledValues(time);
        headEnvelope.gain.setValueAtTime(1, time);
        headEnvelope.gain.linearRampToValueAtTime(0, time + duration);
        this.endTime = time + duration;
        return true;
      },
      dispose,
    };
  }

  AudioContext.prototype.createMediaElementSource = function (audio) {
    const source = create.call(this, audio);
    if (!(audio instanceof HTMLAudioElement)) return source;
    const dry = this.createGain(),
      wet = this.createGain(),
      input = this.createGain(),
      output = this.createGain(),
      boost = this.createGain();
    wet.gain.value = 0;
    input.gain.value = 0;
    connect.call(source, boost);
    boost.connect(dry);
    boost.connect(input);
    const stopBoost = outputLevel.subscribeLevel(audio, ({ outputDb }) => {
      boost.gain.value = 10 ** (Math.max(0, outputDb) / 20);
    });
    dry.connect(output);
    wet.connect(output);
    const state = {
      source,
      input,
      dry,
      wet,
      output,
      audio: new WeakRef(audio),
      epoch: 0,
      latency: 0,
      active: false,
      failed: false,
      connected: false,
      loading: false,
      needsReset: true,
    };
    states.set(audio, state);
    routes.set(source, output);
    for (const event of ['seeking', 'emptied', 'loadstart', 'pause', 'ended']) {
      audio.addEventListener(event, () => {
        clear(state);
      });
    }
    const reference = new WeakRef(state);
    const close = () => {
      if (this.state !== 'closed') return;
      stopBoost();
      const current = reference.deref();
      if (current) {
        try {
          current.gate?.dispose();
        } catch (error) {
          console.warn(error);
        }
        current.buffered = null;
        retire(current);
      }
      this.removeEventListener('statechange', close);
    };
    this.addEventListener('statechange', close);
    audio.addEventListener('seeked', () => apply(audio));
    discover(audio);
    onGraphReady(audio);
    return source;
  };
  AudioNode.prototype.connect = function (...args) {
    return connect.apply(routes.get(this) || this, args);
  };
  AudioNode.prototype.disconnect = function (...args) {
    return disconnect.apply(routes.get(this) || this, args);
  };

  return {
    sync,
    crossfadeReady,
    beginCrossfade,
    prepareIncoming,
    contextFor: (audio) => states.get(audio)?.source.context,
    acquireBuffered,
    hasGraph: (audio) => {
      const state = states.get(audio);
      return Boolean(state && state.source.context.state !== 'closed');
    },
    active: (audio) => Boolean(states.get(audio)?.active),
    label: () => {
      const shift = readKeyShift();
      if (!preservesKey() && !shift) return 'Natural pitch follows speed.';
      if (!readUseWasm() && !shift) return 'Browser pitch preservation.';
      let paused = false;
      for (const reference of references) {
        const audio = reference.deref();
        if (!audio) continue;
        if (audio.paused) {
          paused = true;
          continue;
        }
        const state = states.get(audio);
        if (state?.active)
          return shift
            ? `Key shift ${shift > 0 ? '+' : ''}${shift} semitones.`
            : 'Signalsmith WASM active.';
        if (state?.loading)
          return 'Loading WASM · browser correction until ready.';
        if (state?.failed)
          return shift
            ? 'Key shift unavailable. Reload to retry.'
            : 'WASM unavailable · browser fallback. Reload to retry.';
      }
      if (paused)
        return shift
          ? 'Key shift selected · playback paused.'
          : 'Preserve key selected · playback paused.';
      if (shift)
        return 'Key shift needs a player audio connection. Reload SoundCloud if already playing.';
      return 'Browser fallback · WASM needs a player audio connection. Reload if already playing.';
    },
  };
}
