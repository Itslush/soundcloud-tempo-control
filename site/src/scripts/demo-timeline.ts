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

export function rateAt(points: TempoPoint[], time: number) {
  let rate = points[0].r;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (time < point.t - point.d) return rate;
    if (time >= point.t) {
      rate = point.r;
      continue;
    }
    const progress = (time - (point.t - point.d)) / point.d;
    return rate + (point.r - rate) * progress * progress * (3 - 2 * progress);
  }
  return rate;
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

export function timeTicks(start: number, end: number, divisions: number) {
  const rough = (end - start) / divisions;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const multiple = [1, 2, 5, 10].find((value) => value * magnitude >= rough)!;
  const step = multiple * magnitude;
  const precision = clamp(-Math.floor(Math.log10(step)), 0, 6);
  const ticks = [start];
  for (let time = Math.ceil(start / step) * step; time < end; time += step)
    if (time - start >= step * 0.5 && end - time >= step * 0.5)
      ticks.push(time);
  ticks.push(end);
  return { ticks, precision: Math.max(precision, end - start < 2 ? 2 : 0) };
}

export class EditHistory {
  private undo: string[] = [];
  private redo: string[] = [];
  private current = '';

  constructor(points: TempoPoint[]) {
    this.reset(points);
  }

  reset(points: TempoPoint[]) {
    this.current = JSON.stringify(points);
    this.undo = [];
    this.redo = [];
  }

  commit(points: TempoPoint[]) {
    const next = JSON.stringify(points);
    if (next === this.current) return;
    this.undo.push(this.current);
    if (this.undo.length > 64) this.undo.shift();
    this.redo = [];
    this.current = next;
  }

  move(direction: 'undo' | 'redo'): TempoPoint[] | null {
    const from = this[direction];
    const next = from.pop();
    if (!next) return null;
    this[direction === 'undo' ? 'redo' : 'undo'].push(this.current);
    this.current = next;
    return JSON.parse(next);
  }

  available(direction: 'undo' | 'redo') {
    return this[direction].length > 0;
  }
}
