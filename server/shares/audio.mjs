import { openSync, closeSync, readSync, writeSync, fstatSync } from 'node:fs';
import Module from '../../vendor/signalsmith/wasm-factory.mjs';
import { evaluatePoints, profilePitchAt } from '../../src/tempo-profile.js';

export const SAMPLE_RATE = 44100;
export const MAX_SOURCE_SECONDS = 900;
export const MAX_OUTPUT_SECONDS = 1800;
const QUANTUM = 128;

export async function renderPcm(input, output, profile) {
  const source = openSync(input, 'r');
  let target;
  try {
    target = openSync(output, 'wx');
    const frames = fstatSync(source).size / 8;
    const duration = frames / SAMPLE_RATE;
    if (
      !Number.isInteger(frames) ||
      duration < 1 ||
      duration > MAX_SOURCE_SECONDS
    )
      throw new Error('Discord links support tracks up to 15 minutes.');
    if (Math.abs(duration - profile.duration) > Math.max(2, duration * 0.01))
      throw new Error('The audio length does not match the shared timeline.');
    const wasm = await Module();
    wasm._configure(
      2,
      Math.round(SAMPLE_RATE * 0.12),
      Math.round(SAMPLE_RATE * 0.03),
      true,
    );
    wasm._reset();
    const inputLatency = wasm._inputLatency();
    const outputLatency = wasm._outputLatency();
    const history = inputLatency + outputLatency;
    const pointer = wasm._setBuffers(2, history);
    const packed = Buffer.alloc(history * 8);
    const result = Buffer.alloc(QUANTUM * 8);
    let position =
      -Math.ceil(outputLatency / QUANTUM) * QUANTUM * profile.points[0].r;
    let outputFrame = -Math.ceil(outputLatency / QUANTUM) * QUANTUM;
    while (position < frames) {
      if (outputFrame >= MAX_OUTPUT_SECONDS * SAMPLE_RATE)
        throw new Error(
          'The adjusted track exceeds the 30-minute render limit.',
        );
      const rate = evaluatePoints(
        profile.points,
        Math.max(0, position / SAMPLE_RATE),
      );
      const analysis = position + outputLatency * rate;
      const end = Math.round(analysis + inputLatency);
      const start = end - history;
      packed.fill(0);
      const from = Math.max(0, start);
      const to = Math.min(frames, end);
      if (to > from) {
        const bytes = (to - from) * 8;
        if (
          readSync(source, packed, (from - start) * 8, bytes, from * 8) !==
          bytes
        )
          throw new Error('Audio ended before the timeline.');
      }
      for (let channel = 0; channel < 2; channel++) {
        const view = new Float32Array(
          wasm.HEAP8.buffer,
          pointer + channel * history * 4,
          history,
        );
        for (let i = 0; i < history; i++)
          view[i] = packed.readFloatLE(i * 8 + channel * 4);
      }
      const shift =
        profilePitchAt(profile, Math.max(0, analysis / SAMPLE_RATE)) ?? 0;
      wasm._setTransposeFactor(
        2 ** (shift / 12) * (profile.pitch === 'preserve' ? 1 : rate),
        8000 / SAMPLE_RATE,
      );
      wasm._seek(history, rate);
      wasm._process(0, QUANTUM);
      if (outputFrame >= 0) {
        const count = Math.min(QUANTUM, Math.ceil((frames - position) / rate));
        for (let channel = 0; channel < 2; channel++) {
          const view = new Float32Array(
            wasm.HEAP8.buffer,
            pointer + (channel + 2) * history * 4,
            count,
          );
          for (let i = 0; i < count; i++) {
            if (!Number.isFinite(view[i]))
              throw new Error('The audio renderer produced invalid samples.');
            result.writeFloatLE(view[i], i * 8 + channel * 4);
          }
        }
        writeSync(target, result, 0, count * 8);
        outputFrame += count;
      } else outputFrame += QUANTUM;
      position += QUANTUM * rate;
    }
    return outputFrame / SAMPLE_RATE;
  } finally {
    closeSync(source);
    if (target !== undefined) closeSync(target);
  }
}
