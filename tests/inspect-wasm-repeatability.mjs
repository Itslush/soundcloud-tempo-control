import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import Module from '../vendor/signalsmith/wasm-factory.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sampleRate = 48000;
const quantum = 128;

async function render(rate, prehistory, streaming, blockSamples = 5760) {
  const wasm = await Module();
  wasm._main();
  wasm._configure(2, blockSamples, 1440, true);
  wasm._reset();
  const inputLatency = wasm._inputLatency();
  const outputLatency = wasm._outputLatency();
  const history = inputLatency + outputLatency;
  const pointer = wasm._setBuffers(2, history);
  wasm._setTransposeFactor(1, 8000 / sampleRate);
  wasm._setFormantSemitones(0, false);
  wasm._setFormantBase(0);
  const output = new Float32Array(480000);
  let previousEnd;
  const processing = [];
  for (let frame = 0; frame < output.length; frame += quantum) {
    const end = Math.round((frame + outputLatency) * rate + inputLatency);
    const incremental = streaming && previousEnd !== undefined;
    const length = incremental ? end - previousEnd : history;
    for (let channel = 0; channel < 2; channel++) {
      const input = new Float32Array(wasm.HEAP8.buffer, pointer + channel * history * 4, history);
      for (let index = 0; index < length; index++) {
        const source = end - length + index;
        input[index] = source < 0 && !prehistory ? 0 : 0.1 * Math.sin(2 * Math.PI * 960 * source / sampleRate);
      }
    }
    const began = performance.now();
    if (!incremental) wasm._seek(history, rate);
    wasm._process(incremental ? length : 0, quantum);
    processing.push(performance.now() - began);
    previousEnd = end;
    output.set(new Float32Array(wasm.HEAP8.buffer, pointer + 2 * history * 4, quantum), frame);
  }
  assert(output.every(Number.isFinite));
  const windows = [3840, 48000, 96000, 144000, 192000, 384000].map((startFrame) => {
    const samples = output.subarray(startFrame, startFrame + 16384);
    const crossings = [];
    for (let index = 1; index < samples.length; index++)
      if (samples[index - 1] <= 0 && samples[index] > 0)
        crossings.push(index - 1 - samples[index - 1] / (samples[index] - samples[index - 1]));
    assert(crossings.length > 1);
    const zeroCrossingHz = (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
    const historyEnd = Math.round((startFrame + outputLatency) * rate + inputLatency);
    return { startFrame, frames:samples.length, paddedHistoryFrames:prehistory ? 0 : Math.max(0, history - historyEnd),
      zeroCrossingHz, errorHz:zeroCrossingHz - 960,
      samples:startFrame === 3840 || Math.abs(zeroCrossingHz - 960) > 8 ? Array.from(samples) : undefined };
  });
  processing.sort((a, b) => a - b);
  return { sha256: hash(new Uint8Array(output.buffer)), zeroCrossingHz:windows[0].zeroCrossingHz, windows,
    inputLatency, outputLatency, history,
    processingMs:{mean:processing.reduce((sum, value) => sum + value, 0) / processing.length,
      p99:processing[Math.floor(processing.length * 0.99)], max:processing.at(-1)} };
}

const cases = [];
for (const {rate, prehistory, streaming = false, blockSamples = 5760} of [{rate:1, prehistory:false}, {rate:0.025, prehistory:false}, {rate:0.025, prehistory:true}, {rate:0.025, prehistory:false, streaming:true}, {rate:0.025, prehistory:false, blockSamples:11520}]) {
  const runs = [];
  for (let run = 0; run < 4; run++) runs.push(await render(rate, prehistory, streaming, blockSamples));
  cases.push({ rate, prehistory, streaming, blockSamples, runs, distinctOutputs: new Set(runs.map((run) => run.sha256)).size });
}
const report = {
  status: 'OBSERVED', sampleRate, cases,
  factorySha256: hash(await readFile(new URL('../vendor/signalsmith/wasm-factory.mjs', import.meta.url))),
  scope: 'Identical PCM and frame sequence within each case through fresh pinned WASM instances. Prehistory supplies the known synthetic tone before frame zero as a control, not a proposed production padding policy. No browser, transport, wall clock or audio deadline. Not playback acceptance or proof of the sole cause of pitch failures.',
};
const path = new URL(`../test-results/wasm-repeatability-${Date.now()}.json`, import.meta.url);
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: path.pathname, status:report.status, cases:cases.length }, null, 2));
