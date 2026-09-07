const nativeResult = Symbol('native host result');
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const inherits = (prototype, value) =>
  Object.prototype.isPrototypeOf.call(prototype, value);
const sameDescriptor = (left, right) =>
  Boolean(left && right) &&
  ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every(
    (key) => left[key] === right[key],
  );
const validDuration = (value) =>
  value === null ||
  value === Infinity ||
  (Number.isFinite(value) && value >= 0);

function method(prototype, name) {
  const descriptor = own(prototype, name);
  if (
    !descriptor ||
    typeof descriptor.value !== 'function' ||
    !descriptor.configurable ||
    !descriptor.writable
  )
    throw new TypeError(`Unsupported host method: ${name}`);
  return descriptor;
}

function inheritedDescriptor(value, name) {
  for (let depth = 0; value && depth < 16; depth++) {
    const descriptor = own(value, name);
    if (descriptor) return descriptor;
    value = Object.getPrototypeOf(value);
  }
  return null;
}

function snapshotOf(value) {
  if (
    !value ||
    !Number.isFinite(value.position) ||
    value.position < 0 ||
    typeof value.ended !== 'boolean' ||
    typeof value.paused !== 'boolean' ||
    (value.ended && !value.paused) ||
    (value.ended &&
      (!Number.isFinite(value.duration) ||
        value.position !== value.duration)) ||
    (value.duration !== null &&
      value.duration !== undefined &&
      (!Number.isFinite(value.duration) || value.duration < 0)) ||
    (value.durationHint !== null &&
      value.durationHint !== undefined &&
      (!Number.isFinite(value.durationHint) || value.durationHint < 0))
  )
    throw new TypeError('Invalid owned playback snapshot');
  return value;
}

export function createHostClock({
  basePrototype,
  mediaPrototype,
  leafPrototypes = [],
  onFailure,
  enqueue = queueMicrotask,
  maxDepth = 8,
}) {
  if (
    !basePrototype ||
    !mediaPrototype ||
    !inherits(basePrototype, mediaPrototype) ||
    !Array.isArray(leafPrototypes) ||
    leafPrototypes.some((prototype) => !inherits(mediaPrototype, prototype)) ||
    typeof onFailure !== 'function' ||
    typeof enqueue !== 'function' ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 16
  )
    throw new TypeError('Invalid host clock configuration');
  const baseEnded = method(basePrototype, '_updateEndedInState');
  const mediaClock = method(mediaPrototype, '_getTruePosition');
  const durationChange = method(mediaPrototype, '_handleDurationChange');
  method(mediaPrototype, 'getMediaElement');
  const endedPrototypes = [mediaPrototype, ...leafPrototypes];
  if (new Set(endedPrototypes).size !== endedPrototypes.length)
    throw new TypeError('Duplicate host player prototypes');
  const endedMethods = endedPrototypes.map((prototype) => ({
    prototype,
    descriptor: method(prototype, '_shouldBeEnded'),
  }));
  const records = new Map();
  const pendingRestorations = new Set();
  const patches = [];
  let installed = false;
  let disposed = false;
  let disposal;
  let restorationFailed = false;
  let restorationFailure;
  let hostDepth = 0;

  function report(media, error) {
    return onFailure(media, error);
  }

  function restore(patch) {
    if (!sameDescriptor(own(patch.target, patch.name), patch.replacement))
      return false;
    Object.defineProperty(patch.target, patch.name, patch.original);
    return true;
  }

  function unpatch() {
    if (!installed || records.size) return;
    installed = false;
    for (const patch of patches.toReversed()) restore(patch);
    patches.length = 0;
  }

  function detachLeaf(record, leaf) {
    record.leaves.delete(leaf.player);
    const original = { ...leaf.original, value: leaf.hostDuration };
    return restore({
      ...leaf,
      target: leaf.player,
      name: '_duration',
      original,
    });
  }

  function restoreDuration(record, leaves) {
    if (records.has(record.media)) return;
    if (!restorationMatches(record)) return;
    for (const leaf of leaves) {
      if (!restorationMatches(record, leaf.player)) continue;
      const state = own(leaf.player, '_mediaElementAndState')?.value;
      if (own(state ?? {}, 'element')?.value !== record.media) continue;
      if (
        !sameDescriptor(own(leaf.player, '_duration'), {
          ...leaf.original,
          value: leaf.hostDuration,
        })
      )
        continue;
      Reflect.apply(durationChange.value, leaf.player, []);
    }
  }

  function restorationMatches(record, player) {
    try {
      return record.sourceMatches(player) === true;
    } catch (error) {
      if (error?.code === 'SOUNDCLOUD_HOST_UNSUPPORTED') return false;
      throw error;
    }
  }

  function reserveRestoration(record) {
    let resolveCompletion;
    let rejectCompletion;
    const operation = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    record.restoration = operation;
    pendingRestorations.add(operation);
    operation.then(
      () => pendingRestorations.delete(operation),
      (error) => {
        pendingRestorations.delete(operation);
        if (restorationFailed) return;
        restorationFailed = true;
        restorationFailure = error;
      },
    );
    return { resolve: resolveCompletion, reject: rejectCompletion };
  }

  function startRestoration(
    record,
    leaves,
    completion,
    deferred = false,
    reservation = reserveRestoration(record),
  ) {
    const restoreLater = () =>
      new Promise((resolve, reject) => {
        enqueue(() => {
          try {
            restoreDuration(record, leaves);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    try {
      if (completion !== undefined)
        reservation.resolve(Promise.resolve(completion).then(restoreLater));
      else if (deferred || hostDepth) reservation.resolve(restoreLater());
      else {
        restoreDuration(record, leaves);
        reservation.resolve();
      }
    } catch (error) {
      reservation.reject(error);
    }
  }

  function deactivate(record) {
    if (!record.active) return null;
    record.active = false;
    if (records.get(record.media) === record) records.delete(record.media);
    const restored = [];
    for (const leaf of record.leaves.values())
      if (detachLeaf(record, leaf)) restored.push(leaf);
    unpatch();
    return restored;
  }

  function release(record, synchronize = true) {
    const restored = deactivate(record);
    if (!restored) return false;
    if (synchronize) startRestoration(record, restored);
    return true;
  }

  function fail(record, error) {
    const restored = deactivate(record);
    if (!restored) return;
    const reservation = reserveRestoration(record);
    let completion;
    try {
      completion = report(record.media, error);
    } catch (cause) {
      completion = Promise.reject(cause);
    }
    startRestoration(record, restored, completion, true, reservation);
  }

  function read(record, player) {
    if (!record.active || records.get(record.media) !== record) return null;
    try {
      if (record.sourceMatches() !== true) {
        release(record, false);
        return null;
      }
      if (player && record.sourceMatches(player) !== true) return null;
      return snapshotOf(record.snapshot());
    } catch (error) {
      fail(record, error);
      return null;
    }
  }

  function rejectChain(root, message) {
    const error = new TypeError(message);
    for (const record of [...records.values()]) {
      try {
        if (record.sourceMatches(root) === true) fail(record, error);
      } catch (cause) {
        fail(record, cause);
      }
    }
    return null;
  }

  function resolve(player) {
    const root = player;
    const seen = new Set();
    let synchronized = true;
    for (let depth = 0; player && depth < maxDepth; depth++) {
      if (!inherits(basePrototype, player)) return null;
      if (seen.has(player))
        return rejectChain(root, 'Cyclic host player chain');
      seen.add(player);
      const mediaState = own(player, '_mediaElementAndState');
      if (mediaState) {
        if (!('value' in mediaState) || !inherits(mediaPrototype, player))
          return rejectChain(root, 'Unsupported host media state');
        if (!mediaState.value) return null;
        const element = own(mediaState.value, 'element');
        if (!element || !('value' in element))
          return rejectChain(root, 'Unsupported host media identity');
        const record = records.get(element.value);
        return record
          ? { record, player, state: mediaState.value, synchronized }
          : null;
      }
      const child = own(player, '_player');
      if (!child) return null;
      if (!('value' in child))
        return rejectChain(root, 'Unsupported host player link');
      const sync = own(player, '_synced');
      if (!sync || typeof sync.value !== 'boolean')
        return rejectChain(root, 'Unsupported host synchronization state');
      synchronized &&= sync.value;
      player = child.value;
    }
    return player
      ? rejectChain(root, 'Host player chain exceeds depth limit')
      : null;
  }

  function duration(leaf, snapshot) {
    if (Number.isFinite(snapshot.duration) && snapshot.duration >= 0)
      return snapshot.duration * 1000;
    if (Number.isFinite(snapshot.durationHint) && snapshot.durationHint > 0)
      return snapshot.durationHint * 1000;
    return leaf.hostDuration;
  }

  function queueUpdate(record) {
    if (!record.active || record.queued) return;
    record.queued = true;
    try {
      enqueue(() => {
        record.queued = false;
        update(record);
      });
    } catch (error) {
      record.queued = false;
      fail(record, error);
    }
  }

  function attach(resolved) {
    const { record, player } = resolved;
    if (record.leaves.has(player)) return record.leaves.get(player);
    if (record.leaves.size >= 8)
      throw new RangeError('Owned host player limit exceeded');
    const original = own(player, '_duration');
    if (
      !original ||
      !('value' in original) ||
      !original.configurable ||
      !original.writable ||
      !validDuration(original.value) ||
      inheritedDescriptor(player, '_handleDurationChange')?.value !==
        durationChange.value ||
      !patches.some(
        (patch) =>
          patch.name === '_getTruePosition' &&
          inheritedDescriptor(player, patch.name)?.value ===
            patch.replacement.value,
      ) ||
      !patches.some(
        (patch) =>
          patch.name === '_shouldBeEnded' &&
          inheritedDescriptor(player, patch.name)?.value ===
            patch.replacement.value,
      )
    )
      throw new TypeError('Unsupported owned host player');
    const leaf = {
      player,
      original,
      hostDuration: original.value,
      providedDuration: undefined,
      replacement: null,
    };
    leaf.replacement = {
      configurable: true,
      enumerable: original.enumerable,
      get() {
        const snapshot = read(record, player);
        return snapshot ? duration(leaf, snapshot) : leaf.hostDuration;
      },
      set(value) {
        leaf.hostDuration = value;
        if (!validDuration(value)) {
          fail(record, new TypeError('Invalid host duration assignment'));
          return;
        }
        queueUpdate(record);
      },
    };
    Object.defineProperty(player, '_duration', leaf.replacement);
    record.leaves.set(player, leaf);
    queueUpdate(record);
    return leaf;
  }

  function owned(player) {
    const resolved = resolve(player);
    if (!resolved) return null;
    const snapshot = read(resolved.record, resolved.player);
    if (!snapshot) return null;
    try {
      attach(resolved);
      return { ...resolved, snapshot };
    } catch (error) {
      fail(resolved.record, error);
      return null;
    }
  }

  function update(record) {
    if (hostDepth || record.updating) {
      queueUpdate(record);
      return false;
    }
    const snapshot = read(record);
    if (!snapshot) return false;
    if (
      !patches.every((patch) =>
        sameDescriptor(own(patch.target, patch.name), patch.replacement),
      )
    ) {
      fail(record, new TypeError('Host clock methods changed externally'));
      return false;
    }
    record.updating = true;
    try {
      for (const leaf of record.leaves.values()) {
        const resolved = resolve(leaf.player);
        if (
          !resolved ||
          resolved.record !== record ||
          !read(record, leaf.player)
        ) {
          detachLeaf(record, leaf);
          continue;
        }
        if (!sameDescriptor(own(leaf.player, '_duration'), leaf.replacement))
          throw new TypeError('Owned host duration changed externally');
        const next = duration(leaf, snapshot);
        if (next === leaf.providedDuration) continue;
        leaf.providedDuration = next;
        Reflect.apply(durationChange.value, leaf.player, []);
        if (!record.active) break;
      }
      return record.active;
    } catch (error) {
      fail(record, error);
      return false;
    } finally {
      record.updating = false;
    }
  }

  function guarded(original, operation) {
    return function (...args) {
      hostDepth++;
      try {
        let value;
        try {
          value = owned(this);
          if (value) {
            const result = operation(value, args);
            if (result !== nativeResult) return result;
          }
        } catch (error) {
          const affected = value ? [value.record] : [...records.values()];
          for (const record of affected) {
            try {
              fail(record, error);
            } catch (cleanup) {
              try {
                Promise.resolve(
                  report(
                    record.media,
                    new AggregateError(
                      [error, cleanup],
                      'Host clock recovery failed',
                    ),
                  ),
                ).catch(() => {});
              } catch {}
            }
          }
        }
        return Reflect.apply(original, this, args);
      } finally {
        hostDepth--;
      }
    };
  }

  function install() {
    if (installed) {
      if (
        !patches.every((patch) =>
          sameDescriptor(own(patch.target, patch.name), patch.replacement),
        )
      )
        throw new TypeError('Host clock methods changed externally');
      return;
    }
    const pending = [
      {
        target: basePrototype,
        name: '_updateEndedInState',
        original: baseEnded,
        value: guarded(
          baseEnded.value,
          ({ snapshot, synchronized }, [state]) => {
            const seek = own(state, 'seek')?.value;
            const pending = seek && own(seek, 'state')?.value === 'IN_PROGRESS';
            state.ended = Boolean(
              state.ready &&
                synchronized &&
                snapshot.ended &&
                snapshot.paused &&
                (!pending ||
                  own(seek, 'position')?.value === snapshot.duration * 1000),
            );
          },
        ),
      },
      {
        target: mediaPrototype,
        name: '_getTruePosition',
        original: mediaClock,
        value: guarded(mediaClock.value, ({ snapshot, state }) =>
          own(state, 'state')?.value === 'USABLE'
            ? snapshot.position * 1000
            : nativeResult,
        ),
      },
      ...endedMethods.map(({ prototype, descriptor }) => ({
        target: prototype,
        name: '_shouldBeEnded',
        original: descriptor,
        value: guarded(
          descriptor.value,
          ({ snapshot }) => snapshot.ended && snapshot.paused,
        ),
      })),
    ];
    for (const patch of pending)
      if (!sameDescriptor(own(patch.target, patch.name), patch.original))
        throw new TypeError(`Host method changed externally: ${patch.name}`);
    try {
      for (const patch of pending) {
        patch.replacement = { ...patch.original, value: patch.value };
        Object.defineProperty(patch.target, patch.name, patch.replacement);
        patches.push(patch);
      }
      installed = true;
    } catch (error) {
      for (const patch of patches.toReversed()) restore(patch);
      patches.length = 0;
      throw error;
    }
  }

  function bind(media, { snapshot, sourceMatches } = {}) {
    if (
      disposed ||
      !media ||
      records.has(media) ||
      records.size + pendingRestorations.size >= 8 ||
      typeof snapshot !== 'function' ||
      typeof sourceMatches !== 'function'
    )
      throw new TypeError('Invalid host clock binding');
    if (sourceMatches() !== true)
      throw new Error('Playback source changed before host clock binding');
    snapshotOf(snapshot());
    install();
    const record = {
      media,
      snapshot,
      sourceMatches,
      active: true,
      queued: false,
      updating: false,
      leaves: new Map(),
      restoration: Promise.resolve(),
    };
    records.set(media, record);
    return Object.freeze({
      update: () => update(record),
      release: () => release(record),
      get restoration() {
        return record.restoration;
      },
      get active() {
        return record.active;
      },
    });
  }

  function dispose() {
    if (disposal) return disposal;
    let resolveDisposal;
    let rejectDisposal;
    disposal = new Promise((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    disposed = true;
    try {
      const restoring = [...records.values()];
      for (const record of restoring) release(record);
      Promise.all([
        ...pendingRestorations,
        ...restoring.map((record) => record.restoration),
        ...(restorationFailed ? [Promise.reject(restorationFailure)] : []),
      ]).then(resolveDisposal, rejectDisposal);
    } catch (error) {
      rejectDisposal(error);
    }
    return disposal;
  }

  return Object.freeze({ bind, dispose });
}
