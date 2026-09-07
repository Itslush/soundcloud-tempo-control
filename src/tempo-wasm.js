export function createWasmAudio({
  audioModules,
  outputLevel,
  createStretchNode,
  preservesKey,
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
              if (current) fail(current, new Error('WASM processor stopped'));
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
      await timed(
        node.schedule({ active: true, semitones: -12 * Math.log2(speed) }),
      );
      if (!ready(state, epoch) || speed !== state.speed) return;
      state.applied = speed;
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
    if (state.buffered) return false;
    if (!enabled || audio.seeking || audio.paused) {
      if (changed || state.connected || state.active) clear(state);
      return false;
    }
    if (state.failed || state.source.context.state === 'closed') return false;
    if (state.needsReset || state.applied !== speed) prepare(state);
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
    try {
      for (const node of [state.dry, state.wet]) {
        changed.push({ node, removed: false });
        connect.call(node, nativeMix);
      }
      for (const entry of changed) {
        entry.removed = true;
        disconnect.call(entry.node, state.output);
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
          connect.call(node, state.output);
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

  AudioContext.prototype.createMediaElementSource = function (audio) {
    const source = create.call(this, audio);
    if (!(audio instanceof HTMLAudioElement)) return source;
    const dry = this.createGain(),
      wet = this.createGain(),
      input = this.createGain(),
      output = this.createGain();
    wet.gain.value = 0;
    input.gain.value = 0;
    connect.call(source, dry);
    connect.call(source, input);
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
    acquireBuffered,
    hasGraph: (audio) => {
      const state = states.get(audio);
      return Boolean(state && state.source.context.state !== 'closed');
    },
    active: (audio) => Boolean(states.get(audio)?.active),
    label: () => {
      if (!preservesKey()) return 'Natural pitch follows speed.';
      if (!readUseWasm()) return 'Browser pitch preservation.';
      let paused = false;
      for (const reference of references) {
        const audio = reference.deref();
        if (!audio) continue;
        if (audio.paused) {
          paused = true;
          continue;
        }
        const state = states.get(audio);
        if (state?.active) return 'Signalsmith WASM active.';
        if (state?.loading)
          return 'Loading WASM · browser correction until ready.';
        if (state?.failed)
          return 'WASM unavailable · browser fallback. Reload to retry.';
      }
      if (paused) return 'Preserve key selected · playback paused.';
      return 'Browser fallback · WASM needs a player audio connection. Reload if already playing.';
    },
  };
}
