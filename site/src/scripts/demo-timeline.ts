export type TempoPoint = { t: number; r: number; d: number; c: string };

export const round = (value: number) => Math.round(value * 1000) / 1000;
export const roundTime = (value: number) => Math.round(value * 1e6) / 1e6;
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function formatTime(value: number, precision = 0) {
  const rounded = Math.round(value * 10 ** precision) / 10 ** precision;
  const seconds = (rounded % 60).toFixed(precision);
  return `${Math.floor(rounded / 60)}:${seconds.padStart(precision ? precision + 3 : 2, '0')}`;
}

export function defaultPoints(duration: number): TempoPoint[] {
  return [
    { t: 0, r: 1, d: 0, c: 'instant' },
    {
      t: roundTime(duration / 3),
      r: 0.75,
      d: roundTime(duration / 4),
      c: 'smooth',
    },
    {
      t: roundTime(duration * 0.75),
      r: 0.9,
      d: roundTime(duration / 3),
      c: 'smooth',
    },
  ];
}
