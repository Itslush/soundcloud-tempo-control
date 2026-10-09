export const pitchSettingsKey = 'soundcloud.tempo.pitchControls';
export const defaultPitchSettings = {
  min: -12,
  max: 12,
  step: 0.5,
};
export function validPitchSettings(value) {
  return (
    value &&
    [value.min, value.max, value.step].every(Number.isFinite) &&
    value.min >= -12 &&
    value.max <= 12 &&
    value.min < value.max &&
    value.step >= 0.001 &&
    value.step <= 12
  );
}
export function readPitchSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(pitchSettingsKey));
    if (validPitchSettings(value)) {
      const { min, max, step } = value;
      return { min, max, step };
    }
  } catch {}
  return { ...defaultPitchSettings };
}
