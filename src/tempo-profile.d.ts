import type { TempoProfile, TempoPoint, PitchPoint } from './tempo-editor';
export function validateProfile(
  data: unknown,
  parseTrack: (path: string) => string,
): TempoProfile;
export function evaluatePoints(
  points: TempoPoint[],
  time: number,
  field?: 'r',
): number;
export function evaluatePoints(
  points: PitchPoint[],
  time: number,
  field: 'k',
): number;
export function profilePitchAt(data: TempoProfile, time: number): number | null;
export function validKeyShift(value: unknown): boolean;
