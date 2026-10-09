import type { TempoProfile } from './tempo-editor';
export function encodeTempoCode(data: TempoProfile): string;
export function tempoShareLink(data: TempoProfile, website?: string): string;
export function decodeTempoCode(
  text: string,
  validate: (data: unknown) => TempoProfile,
  parseTrack: (path: string) => string,
  website?: string,
): TempoProfile;
