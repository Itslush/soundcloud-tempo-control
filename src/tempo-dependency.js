import SignalsmithStretch from '../vendor/signalsmith/SignalsmithStretch.js';

export function createStretchNode(
  context,
  options,
  library = SignalsmithStretch,
) {
  if (typeof library !== 'function') {
    throw new Error('Signalsmith dependency is unavailable');
  }
  const worklet = context.audioWorklet;
  const original = worklet.addModule;
  const descriptor = Object.getOwnPropertyDescriptor(worklet, 'addModule');
  const ownsModuleUrl = !library.moduleUrl;
  const addModule = function (url, ...args) {
    const release =
      ownsModuleUrl && typeof url === 'string' && url.startsWith('blob:');
    try {
      const result = original.call(this, url, ...args);
      return release ? result.finally(() => URL.revokeObjectURL(url)) : result;
    } catch (error) {
      if (release) URL.revokeObjectURL(url);
      throw error;
    }
  };
  worklet.addModule = addModule;
  try {
    return library(context, options);
  } finally {
    if (worklet.addModule === addModule) {
      if (descriptor) Object.defineProperty(worklet, 'addModule', descriptor);
      else delete worklet.addModule;
    }
  }
}
