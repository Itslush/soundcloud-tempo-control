export const tempoIncrementKey = 'soundcloud.tempo.tempoIncrement';
export const defaultTempoIncrement = 0.025;

export function validTempoIncrement(value) {
  return Number.isFinite(value) && value >= 0.001 && value <= 1;
}

export function readTempoIncrement() {
  try {
    const value = Number(localStorage.getItem(tempoIncrementKey));
    if (validTempoIncrement(value)) return value;
  } catch {}
  return defaultTempoIncrement;
}
