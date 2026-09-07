import { createHostClock } from './host-clock.mjs';

const SDK_EXPORTS = [
  ['100', 'BasePlayer', 'Ge', 'Ze', 're'],
  ['572', 'HTML5PlayerBase', 'Y', 'X', 'W'],
  ['1280', 'HLSMSEPlayer', 'Q', 'q', 'W'],
];
const METHODS = [
  [
    'BasePlayer',
    '_updateEndedInState',
    '4b87488df4fbc669f140bc22b20c3792bde259d13439f87fac2f7e2f4514daa7',
  ],
  [
    'HTML5PlayerBase',
    '_getTruePosition',
    'd1ddf761395c278e29a3f1428037577d90a00532910bb56f3cd179433023beaa',
  ],
  [
    'HTML5PlayerBase',
    '_getPosition',
    'ffe339100a024d0cc96f30e5b312852413568700444a2faa368379f4814b53ff',
  ],
  [
    'HTML5PlayerBase',
    '_shouldBeEnded',
    'f1d923b19323b757380dec055605a85e0734efb9be1f1d1138383f0facf0d15d',
  ],
  [
    'HTML5PlayerBase',
    '_handleDurationChange',
    'cee858be349e2101d02d6764977cbc6092b102dd8c66be944099067b44bea382',
  ],
  [
    'HLSMSEPlayer',
    '_shouldBeEnded',
    '81653e3dbff82a7fbb9e22c489ada4893e4d6d17aa23c2049705527a9b33832a',
  ],
];
const QUEUE_METHODS = [
  [
    'getCurrentSound',
    'function(){var e=W.getCurrentQueueItem();return null==e?void 0:e.sound}',
  ],
  ['getCurrentQueueItem', 'function(){return P.at(I)}'],
];
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const object = (value) =>
  value !== null && ['object', 'function'].includes(typeof value);
const inherits = (prototype, value) =>
  Object.prototype.isPrototypeOf.call(prototype, value);
const source = (value) => Function.prototype.toString.call(value);
const sameDescriptor = (a, b) =>
  Boolean(a && b) &&
  ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every(
    (key) => a[key] === b[key],
  );

function unsupported(detail, cause) {
  const error = new Error(
    `SoundCloud playback integration is unavailable: ${detail}. Update Tempo Control or use native playback.`,
    { cause },
  );
  error.name = 'SoundCloudHostClockError';
  error.code = 'SOUNDCLOUD_HOST_UNSUPPORTED';
  return error;
}

function stale() {
  const error = new Error('The playing track changed. Try again.');
  error.name = 'SoundCloudHostClockError';
  error.code = 'SOUNDCLOUD_HOST_STALE';
  return error;
}

function data(value, key) {
  const descriptor = object(value) && own(value, key);
  if (!descriptor || !('value' in descriptor))
    throw unsupported(`unexpected ${key} descriptor`);
  return descriptor;
}

function readExport(target, key, descriptor) {
  try {
    return Reflect.apply(descriptor.get, target, []);
  } catch (error) {
    throw unsupported(`the ${key} export could not be read`, error);
  }
}

function inherited(value, key) {
  for (let depth = 0; value && depth < 16; depth++) {
    const descriptor = own(value, key);
    if (descriptor) return descriptor;
    value = Object.getPrototypeOf(value);
  }
  throw unsupported(`missing ${key} method`);
}

function capture(queue, crypto) {
  const push = data(queue, 'push');
  if (
    typeof push.value !== 'function' ||
    push.value === Array.prototype.push ||
    queue.length > 8192 ||
    !data(queue, 'length').writable
  )
    throw unsupported('the page runtime is not initialized');
  for (let index = 0; index < queue.length; index++) {
    const descriptor = own(queue, index);
    if (
      descriptor &&
      (!('value' in descriptor) ||
        !descriptor.writable ||
        !descriptor.configurable)
    )
      throw unsupported('the page runtime queue cannot be restored');
  }
  const id = `soundcloud-tempo-clock-${crypto.randomUUID()}`;
  const sentinel = Object.freeze({});
  let runtime, factories, cache, capturedModule, exportsDescriptor;
  const factory = (module, exports, require) => {
    runtime = require;
    factories = data(require, 'm').value;
    cache = data(require, 'c').value;
    if (!object(factories) || !object(cache))
      throw unsupported('the runtime cache is unavailable');
    if (!object(module))
      throw unsupported('the diagnostic module is unavailable');
    capturedModule = module;
    exportsDescriptor = own(module, 'exports');
    if (!exportsDescriptor || !('value' in exportsDescriptor))
      throw unsupported('unexpected diagnostic exports descriptor');
    if (!exportsDescriptor.writable)
      throw unsupported('the diagnostic module cannot be restored');
    const replacement = {
      ...exportsDescriptor,
      value: sentinel,
    };
    Object.defineProperty(module, 'exports', replacement);
    exportsDescriptor = replacement;
  };
  const packet = [[], { [id]: factory }, [[id]]];
  let failure;
  try {
    Reflect.apply(push.value, queue, [packet]);
    if (
      typeof runtime !== 'function' ||
      data(factories, id).value !== factory ||
      data(cache, id).value !== capturedModule ||
      data(capturedModule, 'exports').value !== sentinel
    )
      throw unsupported('the runtime capture did not complete');
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = [];
    for (const [target, expected] of [
      [factories, factory],
      [cache, capturedModule],
    ]) {
      if (!object(target) || !expected) continue;
      const descriptor = own(target, id);
      if (!descriptor || descriptor.value !== expected) continue;
      if (target === cache) {
        const current = own(expected, 'exports');
        if (
          (current || exportsDescriptor) &&
          !sameDescriptor(current, exportsDescriptor)
        )
          continue;
      }
      if (!descriptor.configurable || !Reflect.deleteProperty(target, id))
        cleanup.push(
          unsupported('a diagnostic registration could not be removed'),
        );
    }
    try {
      const index = Array.prototype.indexOf.call(queue, packet);
      if (index !== -1) Array.prototype.splice.call(queue, index, 1);
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw unsupported(
        'runtime cleanup failed',
        new AggregateError([...(failure ? [failure] : []), ...cleanup]),
      );
  }
  if (failure) throw unsupported('runtime capture failed', failure);
  return { runtime, factories, cache, push };
}

export function createSoundCloudHostClock({
  window = globalThis.window,
  crypto = window?.crypto,
  mediaPrototype = window?.HTMLMediaElement?.prototype,
  createClock = createHostClock,
} = {}) {
  const readers = new Map();
  for (const key of ['src', 'currentSrc', 'srcObject']) {
    const descriptor = mediaPrototype && own(mediaPrototype, key);
    if (typeof descriptor?.get === 'function') readers.set(key, descriptor.get);
  }
  const bindings = new Map();
  let preparation, context, clock, installedMethods;
  let disposed = false;
  let disposal;
  let pending = 0;

  function queueOf() {
    const queue = data(window, 'webpackJsonp').value;
    if (!Array.isArray(queue)) throw unsupported('the page runtime is missing');
    return queue;
  }

  function nativeSource(audio) {
    if (
      !mediaPrototype ||
      !inherits(mediaPrototype, audio) ||
      readers.size !== 3
    )
      throw unsupported('a native media element is required');
    let src, currentSrc, srcObject;
    try {
      src = Reflect.apply(readers.get('src'), audio, []);
      currentSrc = Reflect.apply(readers.get('currentSrc'), audio, []);
      srcObject = Reflect.apply(readers.get('srcObject'), audio, []);
    } catch (error) {
      throw unsupported('the native media source could not be read', error);
    }
    if (
      srcObject !== null ||
      typeof src !== 'string' ||
      typeof currentSrc !== 'string' ||
      !(src || currentSrc)
    )
      throw unsupported('the playing media source is not available');
    return src || currentSrc;
  }

  function sameSource(audio, expected) {
    return nativeSource(audio) === expected;
  }

  function prune() {
    for (const [audio, entry] of bindings)
      if (entry.binding && !entry.binding.active) bindings.delete(audio);
  }

  function stable(value) {
    if (
      queueOf() !== value.queue ||
      !sameDescriptor(own(value.queue, 'push'), value.push)
    )
      throw unsupported('the page runtime changed');
    for (const check of value.checks)
      if (!sameDescriptor(own(check.target, check.key), check.descriptor))
        throw unsupported(`the ${check.key} implementation changed`);
    for (const check of value.exports)
      if (
        readExport(check.target, check.key, check.descriptor) !== check.result
      )
        throw unsupported(`the ${check.key} export changed`);
    prune();
    const live =
      context === value &&
      installedMethods &&
      [...bindings.values()].some((entry) => entry.binding?.active);
    for (let index = 0; index < value.methods.length; index++) {
      const check = value.methods[index];
      if (
        !sameDescriptor(
          own(check.target, check.key),
          live ? installedMethods[index] : check.descriptor,
        )
      )
        throw unsupported(`the ${check.key} implementation changed`);
    }
  }

  async function discover(queue) {
    if (
      typeof crypto?.randomUUID !== 'function' ||
      typeof crypto?.subtle?.digest !== 'function'
    )
      throw unsupported('Web Crypto is unavailable');
    const captured = capture(queue, crypto);
    const value = {
      ...captured,
      queue,
      checks: [],
      exports: [],
      methods: [],
      prototypes: {},
    };
    const remember = (target, key) => {
      const descriptor = data(target, key);
      value.checks.push({ target, key, descriptor });
      return descriptor.value;
    };
    const rememberExport = (target, key, binding) => {
      const descriptor = object(target) && own(target, key);
      if (
        !descriptor ||
        'value' in descriptor ||
        descriptor.configurable ||
        !descriptor.enumerable ||
        descriptor.set !== undefined ||
        typeof descriptor.get !== 'function' ||
        source(descriptor.get) !== `function(){return ${binding}}`
      )
        throw unsupported(`unexpected ${key} export descriptor`);
      const result = readExport(target, key, descriptor);
      value.checks.push({ target, key, descriptor });
      value.exports.push({ target, key, descriptor, result });
      return result;
    };
    remember(captured.runtime, 'm');
    remember(captured.runtime, 'c');
    for (const [id, name, version, build, implementation] of [
      ['20', null],
      ...SDK_EXPORTS,
    ]) {
      const module = remember(captured.cache, id);
      if (remember(module, 'l') !== true)
        throw unsupported(`player module ${id} has not loaded`);
      const exports = remember(module, 'exports');
      if (!name) {
        value.queueExports = exports;
        continue;
      }
      if (
        rememberExport(exports, 'version', version) !== '32.0.0' ||
        rememberExport(exports, 'buildNumber', build) !== 2285
      )
        throw unsupported('this player SDK version is not supported');
      const constructor = rememberExport(exports, name, implementation);
      if (typeof constructor !== 'function')
        throw unsupported(`the ${name} constructor is missing`);
      value.prototypes[name] = remember(constructor, 'prototype');
    }
    const { BasePlayer, HTML5PlayerBase, HLSMSEPlayer } = value.prototypes;
    if (
      !object(BasePlayer) ||
      !inherits(BasePlayer, HTML5PlayerBase) ||
      !inherits(HTML5PlayerBase, HLSMSEPlayer)
    )
      throw unsupported('the player inheritance changed');
    for (const [name, expected] of QUEUE_METHODS) {
      const fn = remember(value.queueExports, name);
      if (typeof fn !== 'function' || source(fn) !== expected)
        throw unsupported(`the ${name} accessor changed`);
      value[name] = fn;
    }
    const mediaElement = remember(HTML5PlayerBase, 'getMediaElement');
    if (typeof mediaElement !== 'function')
      throw unsupported('the media accessor is missing');
    const encoder = new TextEncoder();
    for (const [name, key, expected] of METHODS) {
      const target = value.prototypes[name];
      const descriptor = data(target, key);
      if (
        typeof descriptor.value !== 'function' ||
        !descriptor.configurable ||
        !descriptor.writable
      )
        throw unsupported(`the ${name}.${key} method cannot be adapted`);
      value.methods.push({ target, key, descriptor });
      const bytes = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          encoder.encode(source(descriptor.value)),
        ),
      );
      const digest = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== expected)
        throw unsupported(`the ${name}.${key} fingerprint changed`);
    }
    stable(value);
    return value;
  }

  function currentChain(value, requireSynchronized = true) {
    const item = Reflect.apply(
      value.getCurrentQueueItem,
      value.queueExports,
      [],
    );
    const sound = data(item, 'sound').value;
    if (
      !object(sound) ||
      Reflect.apply(value.getCurrentSound, value.queueExports, []) !== sound
    )
      throw unsupported('the current queue selection is inconsistent');
    const wrapper = data(sound, 'player').value;
    let player = data(wrapper, 'player').value;
    const nodes = [];
    while (object(player) && nodes.length < 8) {
      if (
        nodes.includes(player) ||
        !inherits(value.prototypes.BasePlayer, player)
      )
        throw unsupported('the player chain is invalid');
      nodes.push(player);
      const baseMethod = inherited(player, '_updateEndedInState');
      if (
        !sameDescriptor(
          baseMethod,
          own(value.prototypes.BasePlayer, '_updateEndedInState'),
        )
      )
        throw unsupported('the player completion method is overridden');
      const mediaState = own(player, '_mediaElementAndState');
      if (mediaState) {
        if (
          !('value' in mediaState) ||
          !inherits(value.prototypes.HTML5PlayerBase, player)
        )
          throw unsupported('the media state is unsupported');
        const state = mediaState.value;
        if (state === null) throw stale();
        const phase = data(state, 'state').value;
        const media = data(state, 'element').value;
        if (phase !== 'USABLE') {
          if (phase === 'INITIALIZING' || phase === 'STABLE') throw stale();
          throw unsupported('the media player state is unsupported');
        }
        for (const key of [
          '_getTruePosition',
          '_getPosition',
          '_handleDurationChange',
          '_shouldBeEnded',
        ]) {
          const prototype =
            key === '_shouldBeEnded' &&
            inherits(value.prototypes.HLSMSEPlayer, player)
              ? value.prototypes.HLSMSEPlayer
              : value.prototypes.HTML5PlayerBase;
          if (!sameDescriptor(inherited(player, key), own(prototype, key)))
            throw unsupported(`the leaf ${key} method is overridden`);
        }
        return { item, sound, wrapper, nodes, leaf: player, media };
      }
      const synchronized = data(player, '_synced').value;
      if (
        typeof synchronized !== 'boolean' ||
        (requireSynchronized && !synchronized)
      )
        throw unsupported('the player chain is not synchronized');
      player = data(player, '_player').value;
    }
    throw unsupported('the player chain exceeds its supported shape');
  }

  function selectedChain(value, audio, selected, requireSynchronized = true) {
    stable(value);
    const current = currentChain(value, requireSynchronized);
    if (
      current.media !== audio ||
      (selected &&
        (current.sound !== selected.sound || current.item !== selected.item))
    )
      throw stale();
    return current;
  }

  function ensureClock(value) {
    if (context && context !== value)
      throw unsupported('the active runtime was replaced; reload SoundCloud');
    if (clock) return clock;
    if (typeof createClock !== 'function')
      throw unsupported('the clock adapter is unavailable');
    const created = createClock({
      basePrototype: value.prototypes.BasePlayer,
      mediaPrototype: value.prototypes.HTML5PlayerBase,
      leafPrototypes: [value.prototypes.HLSMSEPlayer],
      onFailure(audio, error) {
        const entry = bindings.get(audio);
        if (!entry)
          throw unsupported('the playback failure owner is missing', error);
        bindings.delete(audio);
        return entry.onFailure(error);
      },
    });
    context = value;
    clock = created;
    return clock;
  }

  async function prepare(audio) {
    if (disposed) throw stale();
    if (pending >= 8)
      throw unsupported('too many playback preparations are pending');
    pending++;
    try {
      const originalSource = nativeSource(audio);
      const queue = queueOf();
      if (!preparation || preparation.queue !== queue) {
        const item = { queue, promise: discover(queue) };
        preparation = item;
        item.promise.catch(() => {
          if (preparation === item) preparation = undefined;
        });
      }
      const value = await preparation.promise;
      if (disposed || !sameSource(audio, originalSource)) throw stale();
      const selected = selectedChain(value, audio);
      let used = false;
      return Object.freeze({
        bind({ snapshot, sourceMatches, onFailure } = {}) {
          if (used || disposed) throw stale();
          if (
            [snapshot, sourceMatches, onFailure].some(
              (fn) => typeof fn !== 'function',
            )
          )
            throw new TypeError(
              'A playback snapshot, source guard and failure handler are required',
            );
          if (!sameSource(audio, originalSource) || sourceMatches() !== true)
            throw stale();
          selectedChain(value, audio, selected);
          prune();
          if (bindings.has(audio))
            throw unsupported('this media element is already bound');
          const core = ensureClock(value);
          const entry = { onFailure, binding: null };
          const matches = (player) => {
            if (
              !sameSource(audio, originalSource) ||
              sourceMatches(player) !== true
            )
              return false;
            let current;
            try {
              current = selectedChain(value, audio, selected, false);
            } catch (error) {
              if (error.code === 'SOUNDCLOUD_HOST_STALE') return false;
              throw error;
            }
            return !player || current.nodes.includes(player);
          };
          bindings.set(audio, entry);
          try {
            entry.binding = core.bind(audio, {
              snapshot,
              sourceMatches: matches,
            });
            installedMethods = value.methods.map(({ target, key }) =>
              own(target, key),
            );
            used = true;
          } catch (error) {
            if (bindings.get(audio) === entry) bindings.delete(audio);
            throw error;
          }
          return Object.freeze({
            update: () => entry.binding.update(),
            release() {
              try {
                return entry.binding.release();
              } finally {
                if (bindings.get(audio) === entry) bindings.delete(audio);
              }
            },
            get restoration() {
              return entry.binding.restoration;
            },
            get active() {
              return entry.binding.active;
            },
          });
        },
      });
    } finally {
      pending--;
    }
  }

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    preparation = undefined;
    disposal = Promise.resolve()
      .then(() => clock?.dispose())
      .finally(() => {
        bindings.clear();
        clock = undefined;
        context = undefined;
        installedMethods = undefined;
      });
    return disposal;
  }

  return Object.freeze({ prepare, dispose });
}
