import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const factoryUrl = process.env.TEMPO_DIAGNOSTIC_FACTORY
  ? pathToFileURL(process.env.TEMPO_DIAGNOSTIC_FACTORY)
  : new URL('../vendor/signalsmith/wasm-factory.mjs', import.meta.url);
const {default: Module} = await import(factoryUrl.href);

const sampleRate = 48000;
const quantum = 128;
const rate = Math.fround(0.025);

function frequency(samples) {
  const crossings = [];
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1] <= 0 && samples[index] > 0)
      crossings.push(index - 1 - samples[index - 1] / (samples[index] - samples[index - 1]));
  }
  assert(crossings.length > 1);
  return (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
}

async function render(blockMs, chirp, rateHint = rate) {
  const wasm = await Module();
  wasm._main();
  wasm._configure(2, Math.round(sampleRate * blockMs / 1000), Math.round(sampleRate * blockMs / 4000), true);
  wasm._reset();
  const inputLatency = wasm._inputLatency();
  const outputLatency = wasm._outputLatency();
  const history = inputLatency + outputLatency;
  const pointer = wasm._setBuffers(2, history);
  wasm._setTransposeFactor(1, 8000 / sampleRate);
  wasm._setFormantSemitones(0, false);
  wasm._setFormantBase(0);
  const output = new Float32Array(65536);
  const firstFrame = -Math.floor(outputLatency / quantum) * quantum;
  for (let frame = firstFrame; frame < output.length; frame += quantum) {
    const end = Math.round(sampleRate + (frame + outputLatency) * rate + inputLatency);
    for (let channel = 0; channel < 2; channel++) {
      const input = new Float32Array(wasm.HEAP8.buffer, pointer + channel * history * 4, history);
      for (let index = 0; index < history; index++) {
        const time = (end - history + index) / sampleRate;
        const relative = time - 1;
        const phase = chirp ? 2400 * relative + 50 / rate * relative * relative : 960 * time;
        input[index] = 0.2 * Math.sin(2 * Math.PI * phase);
      }
    }
    wasm._seek(history, rateHint);
    wasm._process(0, quantum);
    if (frame >= 0) output.set(new Float32Array(wasm.HEAP8.buffer, pointer + 2 * history * 4, quantum), frame);
  }
  assert(output.every(Number.isFinite));
  const earlyEnd = Math.floor(sampleRate * 0.75 / quantum) * quantum;
  const lateEnd = Math.floor(sampleRate * 1.25 / quantum) * quantum;
  const earlyHz = frequency(output.subarray(earlyEnd - 16384, earlyEnd));
  const lateHz = frequency(output.subarray(lateEnd - 16384, lateEnd));
  const slope = (lateHz - earlyHz) * sampleRate / (lateEnd - earlyEnd);
  return {
    chirp, rateHint, inputLatency, outputLatency, history, earlyHz, lateHz, slope,
    withinOriginalThreshold: chirp ? slope >= 75 && slope <= 125 : Math.abs(lateHz - 960) < 8,
    outputSha256: createHash('sha256').update(new Uint8Array(output.buffer)).digest('hex'),
  };
}

const cases = [];
const phaseControl = process.argv.includes('--phase-hint-control');
const configurations = phaseControl
  ? [{blockMs:120, rateHint:rate}, {blockMs:120, rateHint:0.5}]
  : [120, 60, 30, 15].map(blockMs => ({blockMs, rateHint:rate}));
for (const {blockMs, rateHint} of configurations) {
  const runs = [];
  for (let repeat = 0; repeat < 4; repeat++)
    for (const chirp of [false, true]) runs.push(await render(blockMs, chirp, rateHint));
  cases.push({ blockMs, rateHint, runs });
  console.log(JSON.stringify({ blockMs, rateHint, passed: runs.filter(run => run.withinOriginalThreshold).length, total: runs.length }));
}
const report = {
  status: 'OBSERVED', sampleRate, rate, phaseControl, cases,
  factoryUrl: factoryUrl.href,
  factorySha256: createHash('sha256').update(await readFile(factoryUrl)).digest('hex'),
  scope: 'Fixed-window configuration comparison using the pinned WASM and generated PCM. Original frequency and slope thresholds retained. Not production playback acceptance or musical-quality assessment.',
  manipulation: phaseControl ? 'PCM positions still advance at 0.025x. Only the seek rate hint changes to 0.5, which changes the internal prediction factor and disables its randomization. Those effects are not isolated from each other. This deliberately mismatched hint is not a proposed production fix.' : null,
};
const path = new URL(`../test-results/wasm-resolution-${Date.now()}.json`, import.meta.url);
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: path.pathname, status: report.status }));
