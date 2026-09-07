import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRateWindow } from '../src/audio/rate-clock.mjs';
import { createPreserveOutput } from '../src/audio/preserve-output.mjs';
import workletBuild from '../scripts/worklet-assets.cjs';
import { createHash } from 'node:crypto';

const artifact = await workletBuild.buildPreserveWorklet();

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t, { loading, scheduleReply } = {}) {
  const original = globalThis.AudioWorkletNode;
  const nodes = [];
  const messages = [];
  const gains = [];
  class Node extends EventTarget {
    constructor(context, name, options) {
      super();
      this.context = context;
      this.name = name;
      this.generation = options.processorOptions.generation;
      this.disconnected = false;
      this.closed = false;
      this.port = {
        onmessage: null,
        close: () => {
          this.closed = true;
        },
        postMessage: (message) => {
          messages.push(message);
          queueMicrotask(async () => {
            if (message.method === 'schedule' && scheduleReply)
              await scheduleReply.promise;
            let error;
            if (message.method === 'reset' || message.method === 'dispose') {
              if (message.generation <= this.generation)
                error = 'Invalid reset generation';
              else this.generation = message.generation;
            } else if (message.generation !== this.generation)
              error = 'Stale generation';
            this.port.onmessage?.({
              data: {
                type: 'reply',
                id: message.id,
                generation: message.generation,
                error,
                value: this.stats(message.method === 'dispose'),
              },
            });
          });
        },
      };
      nodes.push(this);
      queueMicrotask(() =>
        this.port.onmessage?.({ data: { type: 'ready', ...this.stats() } }),
      );
    }
    stats(disposed = false) {
      return {
        generation: this.generation,
        disposed,
        bufferBytes: 0,
        buffers: 0,
        windows: 0,
        inputLatencyFrames: 256,
        outputLatencyFrames: 128,
        historyFrames: 384,
        heapBytes: 65536,
      };
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  globalThis.AudioWorkletNode = Node;
  t.after(() => {
    globalThis.AudioWorkletNode = original;
  });
  const context = new EventTarget();
  Object.assign(context, {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    audioWorklet: { addModule: () => loading?.promise || Promise.resolve() },
    createGain() {
      const events = [];
      const gain = {
        events,
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime(value, time) {
            events.push({ value, time });
          },
        },
        connect() {},
        disconnect() {
          this.disconnected = true;
        },
      };
      gains.push(gain);
      return gain;
    },
  });
  const destination = { context };
  const output = createPreserveOutput({
    context,
    destination,
    moduleSource: artifact.output,
  });
  t.after(async () => {
    await output.dispose().catch(() => {});
  });
  return { output, context, nodes, messages, gains };
}

test('compiled worklet maps to the pinned unmodified factory excerpt', async () => {
  const upstream = await readFile(
    new URL('../vendor/signalsmith/SignalsmithStretch.js', import.meta.url),
    'utf8',
  );
  const factory = await readFile(
    new URL('../vendor/signalsmith/wasm-factory.mjs', import.meta.url),
    'utf8',
  );
  const lock = JSON.parse(
    await readFile(
      new URL('../vendor/signalsmith/wasm-factory.json', import.meta.url),
      'utf8',
    ),
  );
  const suffix = '\nexport default SignalsmithStretch;\n';
  assert.ok(factory.endsWith(suffix));
  assert.ok(upstream.includes(factory.slice(0, -suffix.length)));
  assert.equal(createHash('sha256').update(factory).digest('hex'), lock.sha256);
  assert.equal(
    createHash('sha256').update(upstream).digest('hex'),
    lock.upstreamSha256,
  );
  const map = JSON.parse(artifact.sourceMap);
  const index = map.sources.indexOf('vendor/signalsmith/wasm-factory.mjs');
  assert.ok(index >= 0);
  assert.equal(map.sourcesContent[index], factory);
  assert.ok(artifact.output.includes('soundcloud-preserve-buffered-v1'));
});

test('reset before initialization carries its generation into the reused processor contract', async (t) => {
  const { output, nodes } = fixture(t);
  for (const key of ['bufferBytes', 'buffers', 'windows', 'peakBufferBytes'])
    assert.equal(output.stats()[key], 0);
  assert.equal(output.stats().nodes, 1);
  await output.reset();
  await output.initialize({ sourceSampleRate: 44100 });
  assert.equal(nodes[0].generation, 1);
  assert.equal(output.stats().generation, 1);
  assert.equal(output.stats().sampleRatePitchFactor, 44100 / 48000);
});

test('consecutive resets wait for distinct ordered processor acknowledgements', async (t) => {
  const { output, nodes, messages } = fixture(t);
  await output.initialize({ sourceSampleRate: 48000 });
  await Promise.all([output.reset(), output.reset(), output.reset()]);
  assert.deepEqual(
    messages.map((message) => message.generation),
    [1, 2, 3],
  );
  assert.equal(nodes[0].generation, 3);
  assert.equal(output.stats().error, null);
  assert.equal(nodes.length, 1);
});

test('resets issued while initialization is pending retain their own epochs', async (t) => {
  const loading = deferred();
  const { output, messages } = fixture(t, { loading });
  const initial = output.initialize({ sourceSampleRate: 48000 });
  const reset1 = output.reset();
  const reset2 = output.reset();
  loading.resolve();
  await Promise.all([initial, reset1, reset2]);
  assert.deepEqual(
    messages.map((message) => message.generation),
    [1, 2],
  );
  assert.equal(output.stats().generation, 2);
  assert.equal(output.stats().error, null);
});

test('concurrent disposal shares completion and closes the sole node and gain', async (t) => {
  const { output, nodes, gains, messages } = fixture(t);
  await output.initialize({ sourceSampleRate: 48000 });
  const first = output.dispose();
  assert.equal(output.dispose(), first);
  await first;
  assert.equal(
    messages.filter((message) => message.method === 'dispose').length,
    1,
  );
  assert.ok(nodes[0].disconnected && nodes[0].closed && gains[0].disconnected);
  assert.equal(output.stats().nodes, 0);
});

test('disposal during module loading prevents late worklet creation', async (t) => {
  const loading = deferred();
  const { output, nodes } = fixture(t, { loading });
  const initial = output.initialize({ sourceSampleRate: 48000 });
  const settled = assert.rejects(initial, /disposed/);
  await output.dispose();
  loading.resolve();
  await settled;
  assert.equal(nodes.length, 0);
});

test('PCM requirements include engine history and worst-case future analysis', async (t) => {
  const { output } = fixture(t);
  await output.initialize({ sourceSampleRate: 44100 });
  assert.deepEqual(
    output.requiredPcmRange({
      sourceSampleRate: 44100,
      outputSampleRate: 48000,
      sourceStartFrame: 1000.5,
      sourceEndFrame: 2000.5,
    }),
    {
      startFrame: 744,
      endFrame: 2001 + 256 + Math.ceil(((4 * 44100) / 48000) * 128) + 128,
    },
  );
  assert.equal(output.minimumLeadSeconds, 128 / 48000 + 0.06);
});

test('processor failures mute immediately and notify subscribers', async (t) => {
  const { output, nodes, gains } = fixture(t);
  const errors = [];
  output.subscribeFailure((error) => errors.push(error.message));
  await output.initialize({ sourceSampleRate: 48000 });
  gains[0].gain.value = 1;
  nodes[0].port.onmessage({
    data: { type: 'failure', generation: 0, message: 'Lost PCM history' },
  });
  assert.deepEqual(errors, ['Lost PCM history']);
  assert.equal(gains[0].gain.value, 0);
  assert.throws(() => output.requiredPcmRange({}), /Lost PCM history/);
});

test('late schedule acknowledgement fails without opening a stale output gate', async (t) => {
  const scheduleReply = deferred();
  const { output, context, messages, gains } = fixture(t, { scheduleReply });
  await output.initialize({ sourceSampleRate: 48000 });
  const clock = createRateWindow({
    outputStartFrame: 4864,
    sourceStartFrame: 0,
    sourceSampleRate: 48000,
    outputSampleRate: 48000,
    frameCount: 1024,
    rateAt: () => 1,
  });
  const range = output.requiredPcmRange(clock);
  const scheduled = output.schedule({
    clock,
    sampleRate: 48000,
    pcmStartFrame: range.startFrame,
    channels: [
      new Float32Array(range.endFrame),
      new Float32Array(range.endFrame),
    ],
  });
  const rejected = assert.rejects(scheduled, /activation deadline/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.at(-1).method, 'schedule');
  context.currentTime = 0.2;
  scheduleReply.resolve();
  await rejected;
  assert.equal(gains[0].gain.value, 0);
  assert.equal(
    gains[0].events.some(({ value }) => value === 1),
    false,
  );
  assert.match(output.stats().error.message, /activation deadline/);
});
