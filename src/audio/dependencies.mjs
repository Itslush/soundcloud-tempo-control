export async function loadAudioDependencies({ signal } = {}) {
  signal?.throwIfAborted();
  const { Mediabunny } = await import('./decoder.mjs');
  signal?.throwIfAborted();
  return Object.freeze({ Mediabunny });
}
