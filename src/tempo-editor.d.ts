export type TempoPoint = { t: number; r: number; d: number; c: string };
export type PitchPoint = { t: number; k: number; d: number; c: string };
export type TempoProfile = {
  v: number;
  track: string;
  duration: number;
  points: TempoPoint[];
  pitch?: string;
  keyShift?: number;
  pitchPoints?: PitchPoint[];
};
export function createTempoEditor(api: Record<string, unknown>): {
  value(): number | null;
  keyShift(): number | null;
  pitchMode(): string | null;
  draftProfile(): TempoProfile | null;
  draftPlayback(
    time: number,
  ): { rate: number; pitch: string; keyShift: number } | null;
  loadDraft(data: unknown): void;
  changeTrack(track: string): void;
  observe(audio: HTMLMediaElement): void;
  suspend(): void;
  setKeyShift(value: number): void;
};
