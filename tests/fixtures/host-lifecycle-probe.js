(runtime) => {
  if (globalThis.hostLifecycleProbe)
    throw new Error('Lifecycle probe already installed');
  const prototype = runtime.c['100']?.exports.BasePlayer?.prototype;
  if (!prototype) throw new Error('Loaded BasePlayer is unavailable');
  const patches = [];
  const events = [];
  const mediaErrors = [];
  let media;
  const captureMediaError = () => {
    if (mediaErrors.length >= 8) return;
    const error = media.error;
    mediaErrors.push({
      time: performance.now(),
      label:
        document
          .querySelector('#soundcloud-tempo-control')
          ?.shadowRoot?.querySelector('#wasm-status')?.textContent ?? null,
      error: error ? { code: error.code, message: error.message } : null,
    });
  };
  let dropped = 0;
  const own = (value, key) =>
    value && Object.getOwnPropertyDescriptor(value, key)?.value;
  const restore = () => {
    media?.removeEventListener('error', captureMediaError, true);
    for (const patch of patches) {
      if (own(prototype, patch.name) === patch.wrapper)
        Object.defineProperty(prototype, patch.name, patch.original);
    }
    return patches.every(
      (patch) => own(prototype, patch.name) !== patch.wrapper,
    );
  };
  try {
    let player = runtime.c['20']?.exports.getCurrentSound()?.player?.player;
    for (let depth = 0; player && depth < 8; depth++) {
      media = own(own(player, '_mediaElementAndState'), 'element');
      if (media) break;
      player = own(player, '_player');
    }
    media?.addEventListener('error', captureMediaError, true);
    for (const name of ['kill', '_triggerError']) {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof original?.value !== 'function' || !original.configurable)
        throw new Error(`Unsupported lifecycle method: ${name}`);
      const wrapper = function (...args) {
        if (events.length < 32) {
          const state = own(own(this, '_stateManager'), '_state');
          const values = Object.fromEntries(
            Object.entries(Object.getOwnPropertyDescriptors(state || {}))
              .filter(([, item]) =>
                ['boolean', 'number', 'string'].includes(typeof item.value),
              )
              .map(([key, item]) => [key, item.value]),
          );
          events.push({
            name,
            time: performance.now(),
            state: values,
            error:
              args[0] instanceof Error
                ? {
                    name: args[0].name,
                    message: args[0].message,
                    stack: args[0].stack,
                  }
                : null,
            stack: new Error().stack,
          });
        } else dropped++;
        return Reflect.apply(original.value, this, args);
      };
      patches.push({ name, original, wrapper });
      Object.defineProperty(prototype, name, { ...original, value: wrapper });
    }
  } catch (error) {
    restore();
    throw error;
  }
  globalThis.hostLifecycleProbe = {
    snapshot: () => ({
      events: events.slice(),
      dropped,
      mediaErrors: mediaErrors.slice(),
    }),
    restore,
  };
  return {
    installed: patches.map((patch) => patch.name),
    capacity: 32,
    mediaErrorListener: Boolean(media),
  };
};
