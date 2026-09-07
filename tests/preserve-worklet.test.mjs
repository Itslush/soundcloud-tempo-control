import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { registerPreserveProcessor } from '../src/audio/preserve-worklet.mjs';
import { createRateWindow } from '../src/audio/rate-clock.mjs';

async function fixture(options = {}) {
  let Processor;
  const messages = [];
  const calls = { reset: 0, configure: 0 };
  const wasm = {
    HEAP8: new Int8Array(65536),
    _main() {},
    _configure(...args) {
      calls.configure++;
      calls.configuration = args;
    },
    _reset() {
      calls.reset++;
    },
    _inputLatency: () => 256,
    _outputLatency: () => 128,
    _setBuffers: () => 0,
    _setTransposeFactor(value) {
      calls.pitch = value;
    },
    _setFormantSemitones() {},
    _setFormantBase() {},
    _seek(length, rate) {
      calls.seek = { length, rate };
    },
    _process() {
      new Float32Array(wasm.HEAP8.buffer, 384 * 2 * 4, 128).fill(0.125);
      new Float32Array(wasm.HEAP8.buffer, 384 * 3 * 4, 128).fill(0.125);
    },
  };
  const scope = {
    sampleRate: 48000,
    currentFrame: 0,
    Float32Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (message) => messages.push(message) };
      }
    },
    registerProcessor: (_, value) => {
      Processor = value;
    },
    Module: async () => wasm,
  };
  vm.runInNewContext(`(${registerPreserveProcessor})(Module, 'test')`, scope);
  const processor = new Processor({
    processorOptions: {
      sourceSampleRate: 48000,
      generation: 0,
      maxBufferBytes: 8 * 1024 * 1024,
      maxWindows: 8,
      ...options,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[0].type, 'ready');
  return { processor, scope, wasm, messages, calls };
}

function window(start = 1024, position = 0, rate = 1, sourceRate = 48000) {
  const clock = createRateWindow({
    outputStartFrame: start,
    sourceStartFrame: position,
    sourceSampleRate: sourceRate,
    outputSampleRate: 48000,
    frameCount: 1024,
    rateAt: () => rate,
  });
  return { ...clock, sourceAt: undefined, outputAt: undefined };
}

test('real-time configuration splits computation without changing block sizes', async () => {
  const { calls } = await fixture();
  assert.deepEqual(calls.configuration, [2, 5760, 1440, true]);
});

test('history copy matches independent sample indexing across uneven chunks and padded starts', async () => {
  const { processor, wasm } = await fixture();
  let copied = 0;
  for (let end = 0; end <= 4000; end += 7) {
    processor.dropBuffers();
    for (let start = 0; start < 4096; ) {
      const length = Math.min(4096 - start, ((start * 31) % 127) + 1);
      const channels = [0, 1].map((channel) =>
        Float32Array.from(
          { length },
          (_, index) => (start + index + channel) / 4096,
        ),
      );
      processor.addBuffers(start, channels);
      start += length;
    }
    processor.copyHistory(end);
    for (let channel = 0; channel < 2; channel++) {
      const actual = new Float32Array(
        wasm.HEAP8.buffer,
        channel * 384 * 4,
        384,
      );
      for (let index = 0; index < actual.length; index++) {
        const source = end - actual.length + index;
        assert.equal(
          actual[index],
          source < 0 ? 0 : Math.fround((source + channel) / 4096),
        );
        copied++;
      }
    }
  }
  assert.equal(copied, 439296);
});

test('only actual beginning and verified EOF are zero-padded', async () => {
  const { processor, wasm } = await fixture();
  processor.addBuffers(0, [
    new Float32Array(100).fill(0.5),
    new Float32Array(100).fill(0.25),
  ]);
  assert.throws(() => processor.copyHistory(300), /incomplete/);
  processor.totalFrames = 100;
  processor.copyHistory(300);
  const left = new Float32Array(wasm.HEAP8.buffer, 0, 384);
  assert.ok(left.subarray(0, 84).every((value) => value === 0));
  assert.ok(left.subarray(84, 184).every((value) => value === 0.5));
  assert.ok(left.subarray(184).every((value) => value === 0));
});

test('history replaces dirty samples across interior and boundary padding', async () => {
  const { processor } = await fixture();
  processor.addBuffers(0, [
    new Float32Array(2048).fill(0.5),
    new Float32Array(2048).fill(0.25),
  ]);
  processor.totalFrames = 2048;
  processor.updateViews();
  for (const end of [128, 1024, 2200, 2500]) {
    for (const view of processor.inputViews)
      Float32Array.prototype.fill.call(view, 99);
    processor.copyHistory(end);
    const start = end - processor.historyLength;
    for (let channel = 0; channel < 2; channel++)
      for (let index = 0; index < processor.historyLength; index++) {
        const frame = start + index;
        assert.equal(
          processor.inputViews[channel][index],
          frame < 0 || frame >= 2048 ? 0 : channel ? 0.25 : 0.5,
        );
      }
  }
});

test('byte limits and missing history fail instead of reading outside a block', async () => {
  const { processor } = await fixture({ maxBufferBytes: 8192 });
  processor.addBuffers(1000, [new Float32Array(1024), new Float32Array(1024)]);
  assert.throws(
    () =>
      processor.addBuffers(2024, [new Float32Array(1), new Float32Array(1)]),
    /budget/,
  );
  assert.throws(() => processor.copyHistory(900), /incomplete/);
  assert.equal(processor.stats().bufferBytes, 8192);
});

test('reset clears PCM and schedules while reusing the initialized WASM module', async () => {
  const { processor, calls, messages } = await fixture();
  processor.addBuffers(0, [new Float32Array(2048), new Float32Array(2048)]);
  processor.windows.push(window());
  processor.message({ id: 1, generation: 1, method: 'reset' });
  assert.equal(messages.at(-1).value.generation, 1);
  assert.equal(processor.stats().bufferBytes, 0);
  assert.equal(processor.stats().windows, 0);
  assert.equal(calls.configure, 1);
  assert.equal(calls.reset, 2);
  processor.message({ id: 2, generation: 0, method: 'schedule', value: {} });
  assert.match(messages.at(-1).error, /Stale/);
});

test('processor uses source/output ratio for both time and pitch conversion', async () => {
  const { processor, scope, calls } = await fixture({
    sourceSampleRate: 44100,
  });
  processor.addBuffers(0, [new Float32Array(8192), new Float32Array(8192)]);
  processor.windows.push(window(1024, 1024, 0.85, 44100));
  scope.currentFrame = 1024;
  const output = [new Float32Array(128), new Float32Array(128)];
  assert.equal(processor.process([], [output]), true);
  assert.equal(calls.pitch, 44100 / 48000);
  assert.equal(calls.seek.rate, (Math.fround(0.85) * 44100) / 48000);
  assert.ok(output[0].every((value) => value === 0.125));
});

test('process errors mute both channels and release queued PCM', async () => {
  const { processor, scope, messages } = await fixture();
  processor.windows.push(window(1024, 10000));
  scope.currentFrame = 1024;
  const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
  processor.process([], [output]);
  assert.equal(messages.at(-1).type, 'failure');
  assert.ok(output.every((channel) => channel.every((value) => value === 0)));
  assert.equal(processor.stats().buffers, 0);
  assert.equal(processor.stats().windows, 0);
});

test('analysis in a future scheduling gap retains the preceding source mapping', async () => {
  const { processor, scope, calls } = await fixture();
  processor.addBuffers(0, [new Float32Array(8192), new Float32Array(8192)]);
  processor.windows.push(window(1024, 1024), window(4096, 100000, 4));
  scope.currentFrame = 1920;
  const output = [new Float32Array(128), new Float32Array(128)];
  processor.process([], [output]);
  assert.equal(processor.failed, false);
  assert.equal(calls.seek.rate, 1);
  assert.ok(output[0].every((value) => value === 0.125));
});

test('future truncation preserves earlier windows and rejects an already analyzed cut', async () => {
  const { processor, messages, scope } = await fixture();
  processor.windows.push(window(1024), window(2048, 1024));
  processor.lastEnd = 3072;
  processor.message({ id: 1, generation: 0, method: 'truncate', value: 1536 });
  assert.equal(messages.at(-1).error, undefined);
  assert.equal(processor.windows.length, 1);
  assert.equal(processor.windows[0].outputEndFrame, 1536);
  assert.equal(processor.windows[0].sourceEndFrame, 512);
  scope.currentFrame = 1408;
  processor.message({ id: 2, generation: 0, method: 'truncate', value: 1536 });
  assert.match(messages.at(-1).error, /late/);
});
