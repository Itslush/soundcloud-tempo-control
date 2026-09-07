import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateWindow } from '../src/audio/rate-clock.mjs';
import { createNaturalOutput } from '../src/audio/natural-output.mjs';

class FakeBuffer {
  constructor(context, channels, length, sampleRate) {
    this.context = context;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
  }
  copyToChannel(values, channel) {
    this.context.trip('copy');
    this.channels[channel].set(values);
  }
  getChannelData(channel) {
    return this.channels[channel];
  }
}

class FakeSource {
  constructor(context) {
    this.context = context;
    this.listeners = new Set();
    this.starts = [];
    this.stops = [];
    this.steps = [];
    this.rateCancellations = [];
    this.disconnected = false;
    let rate = 1;
    this.playbackRate = {
      get value() {
        return rate;
      },
      set value(value) {
        context.trip('rate');
        rate = value;
      },
      setValueAtTime: (value, time) => {
        context.trip('automation');
        this.steps.push([value, time]);
      },
      cancelScheduledValues: (time) => {
        context.trip('rateCancel');
        this.rateCancellations.push(time);
      },
    };
  }
  set buffer(value) {
    this.context.trip('buffer');
    this.storedBuffer = value;
  }
  get buffer() {
    return this.storedBuffer;
  }
  addEventListener(type, callback) {
    this.context.trip('listener');
    assert.equal(type, 'ended');
    this.listeners.add(callback);
    this.savedEnded = callback;
  }
  removeEventListener(type, callback) {
    this.listeners.delete(callback);
  }
  connect(destination) {
    this.context.trip('connect');
    this.destination = destination;
  }
  disconnect() {
    this.context.trip('disconnect');
    this.disconnected = true;
    this.destination = null;
  }
  start(...args) {
    this.context.trip('start');
    this.starts.push(args);
  }
  stop(...args) {
    this.context.trip('stop');
    this.stops.push(args);
  }
  end() {
    for (const callback of [...this.listeners]) callback();
  }
}

class FakeGain {
  constructor(context) {
    this.context = context;
    this.steps = [];
    this.cancellations = [];
    this.gain = {
      value: 1,
      automationRate: 'a-rate',
      setValueAtTime: (value, time) => {
        context.trip('gate');
        this.steps.push([value, time]);
      },
      cancelScheduledValues: (time) => {
        context.trip('gateCancel');
        this.cancellations.push(time);
      },
    };
  }
  connect(destination) {
    this.context.trip('gainConnect');
    this.destination = destination;
  }
  disconnect() {
    this.context.trip('gainDisconnect');
    this.disconnected = true;
    this.destination = null;
  }
}

class FakeContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = { context: this };
    this.buffers = [];
    this.sources = [];
    this.gains = [];
    this.listeners = new Set();
  }
  trip(stage) {
    if (this.failAt === stage) {
      this.failAt = null;
      throw new Error('Injected ' + stage + ' failure');
    }
  }
  createBuffer(...args) {
    this.trip('createBuffer');
    const buffer = new FakeBuffer(this, ...args);
    this.buffers.push(buffer);
    if (this.afterCreateBuffer) this.afterCreateBuffer();
    return buffer;
  }
  createBufferSource() {
    this.trip('createSource');
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }
  createGain() {
    this.trip('createGain');
    const gain = new FakeGain(this);
    this.gains.push(gain);
    return gain;
  }
  addEventListener(type, callback) {
    assert.equal(type, 'statechange');
    this.listeners.add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.delete(callback);
  }
  close() {
    this.state = 'closed';
    for (const callback of [...this.listeners]) callback();
  }
}

function clock(options = {}) {
  return createRateWindow({
    outputStartFrame: 128,
    sourceStartFrame: 256.375,
    sourceSampleRate: 44100,
    outputSampleRate: 48000,
    frameCount: 256,
    rateAt: () => 0.85,
    ...options,
  });
}

function pcm(program = clock(), options = {}) {
  const { length = 4096, ...rest } = options;
  return {
    clock: program,
    sampleRate: program.sourceSampleRate,
    pcmStartFrame: 0,
    channels: [
      Float32Array.from({ length }, (_, index) => index / 10000),
      Float32Array.from({ length }, (_, index) => -index / 20000),
    ],
    ...rest,
  };
}

function renderer(context = new FakeContext(), limits) {
  return createNaturalOutput({
    context,
    destination: context.destination,
    limits,
  });
}

function next(program, options = {}) {
  return clock({
    sourceStartFrame: program.sourceEndFrame,
    outputStartFrame: program.outputEndFrame,
    ...options,
  });
}

test('copies only owned padded PCM and preserves fractional origin and verified rate scheduling', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const program = clock({ rateAt: (time) => (time < 0.008 ? 0.85 : 0.25) });
  const input = pcm(program);
  const result = output.schedule(input);
  const source = context.sources[0],
    buffer = source.buffer;
  assert.equal(
    result.bufferStartFrame,
    Math.floor(program.sourceStartFrame) - 128,
  );
  assert.equal(result.bufferEndFrame, Math.ceil(program.sourceEndFrame) + 128);
  assert.equal(buffer.length, result.bufferEndFrame - result.bufferStartFrame);
  assert.equal(buffer.sampleRate, 44100);
  assert.deepEqual(
    buffer.channels[0],
    input.channels[0].slice(result.bufferStartFrame, result.bufferEndFrame),
  );
  assert.notEqual(buffer.channels[0].buffer, input.channels[0].buffer);
  input.channels[0].fill(99);
  assert.notEqual(buffer.channels[0][0], 99);
  assert.equal(source.playbackRate.value, program.intervals[0].rate);
  assert.deepEqual(
    source.steps,
    program.intervals.map((interval) => [
      interval.rate,
      (interval.outputFrame - 0.5) / 48000,
    ]),
  );
  const preroll =
    program.outputStartFrame / 48000 -
    0.375 / (program.intervals[0].rate * 44100);
  assert.equal(result.prerollStartTime, preroll);
  assert.deepEqual(source.starts, [
    [
      preroll,
      (Math.floor(program.sourceStartFrame) - result.bufferStartFrame) / 44100,
    ],
  ]);
  assert.deepEqual(source.stops, [[program.outputEndFrame / 48000]]);
  assert.equal(source.destination, context.gains[0]);
  assert.equal(context.gains[0].destination, context.destination);
  assert.equal(context.gains[0].gain.automationRate, 'k-rate');
  assert.equal(context.gains[0].gain.value, 0);
  assert.deepEqual(context.gains[0].steps, [
    [1, (program.outputStartFrame - 0.5) / 48000],
  ]);
  assert.equal(output.stats().bufferBytes, buffer.length * 8);
  assert.equal(output.stats().nodes, 2);
  assert.equal(output.stats().sourceNodes, 1);
  assert.equal(output.stats().gainNodes, 1);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(output) &&
      Object.isFrozen(output.stats()),
  );
});

test('accepts absolute PCM slices without retaining or copying their unrelated prefix', () => {
  const context = new FakeContext();
  const program = clock();
  const input = pcm(program, { pcmStartFrame: 100, length: 1000 });
  const result = renderer(context).schedule(input);
  assert.deepEqual(
    context.buffers[0].channels[1],
    input.channels[1].slice(
      result.bufferStartFrame - 100,
      result.bufferEndFrame - 100,
    ),
  );
});

test('clips trailing interpolation padding only at declared EOF and handles fractional-quantum EOF', () => {
  const context = new FakeContext();
  const output = renderer(context, { maxAheadSeconds: 0.004 });
  const program = clock({ sourceSampleRate: 48000, rateAt: () => 1 });
  const result = output.schedule(
    pcm(program, { length: 300, totalSourceFrames: 300 }),
  );
  assert.equal(result.sourceEndFrame, 300);
  assert.equal(result.outputEndFrame, program.outputAt(300));
  assert.ok(result.outputEndFrame % 128 !== 0);
  assert.equal(result.bufferEndFrame, 300);
  assert.equal(output.stats().lastOutputEndFrame, result.outputEndFrame);
  assert.deepEqual(context.sources[0].stops, [[result.outputEndFrame / 48000]]);
  assert.ok(
    context.sources[0].steps.every(
      ([, time]) => time < result.outputEndFrame / 48000,
    ),
  );
  const initial = new FakeContext();
  const initialClock = clock({
    sourceStartFrame: 0,
    outputStartFrame: 0,
    sourceSampleRate: 48000,
    frameCount: 128,
    rateAt: () => 1,
  });
  const initialResult = renderer(initial).schedule(
    pcm(initialClock, { length: 200, totalSourceFrames: 200 }),
  );
  assert.equal(initialResult.bufferStartFrame, 0);
  assert.equal(initialResult.bufferEndFrame, 200);
  assert.deepEqual(initial.sources[0].steps[0], [1, 0]);
  assert.deepEqual(initial.gains[0].steps[0], [1, 0]);
});

test('allows absolute source origin zero without a known EOF while requiring trailing interpolation neighbors', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const initial = clock({
    sourceStartFrame: 0,
    outputStartFrame: 0,
    sourceSampleRate: 48000,
    frameCount: 128,
    rateAt: () => 1,
  });
  assert.throws(
    () => output.schedule(pcm(initial, { length: 255 })),
    /padding/,
  );
  assert.equal(context.buffers.length, 0);
  const result = output.schedule(pcm(initial, { length: 256 }));
  assert.equal(result.bufferStartFrame, 0);
  assert.equal(result.bufferEndFrame, 256);
  assert.equal(result.sourceEndFrame, 128);
  assert.deepEqual(context.sources[0].starts, [[0, 0]]);
  assert.deepEqual(context.sources[0].stops, [[128 / 48000]]);
});

test('rejects absent interpolation neighbors and invalid declared file ranges before allocation', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const program = clock();
  const invalid = [
    pcm(program, { pcmStartFrame: 200 }),
    pcm(program, { length: Math.ceil(program.sourceEndFrame) }),
    pcm(program, { totalSourceFrames: 100 }),
    pcm(program, { length: 200, totalSourceFrames: 200 }),
    pcm(program, { totalSourceFrames: NaN }),
    pcm(program, { totalSourceFrames: 4096.5 }),
    pcm(program, { totalSourceFrames: 0 }),
  ];
  for (const input of invalid)
    assert.throws(() => output.schedule(input), RangeError);
  assert.equal(context.buffers.length, 0);
  assert.equal(output.stats().nodes, 0);
});

test('rejects malformed stereo PCM, rates, origins and copied nonfinite samples', () => {
  const context = new FakeContext();
  const output = renderer(context);
  for (const change of [
    { channels: [] },
    { channels: [new Float32Array(1000)] },
    { channels: [[], []] },
    { channels: [new Float32Array(0), new Float32Array(0)] },
    { channels: [new Float32Array(1000), new Float32Array(999)] },
    { pcmStartFrame: -0.5 },
    { pcmStartFrame: 1.5 },
    { pcmStartFrame: Infinity },
  ])
    assert.throws(() => output.schedule(pcm(clock(), change)), TypeError);
  for (const sampleRate of [0, 7999, 48000.5, Infinity, '44100', 48000])
    assert.throws(
      () => output.schedule(pcm(clock(), { sampleRate })),
      RangeError,
    );
  for (const value of [NaN, Infinity, -Infinity]) {
    const input = pcm();
    input.channels[1][300] = value;
    assert.throws(() => output.schedule(input), /nonfinite/);
  }
  assert.equal(context.sources.length, 0);
  assert.equal(output.stats().bufferBytes, 0);
});

test('rejects mismatched context clocks and inconsistent interval data', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const original = clock();
  const invalid = [
    { ...original, outputSampleRate: 96000 },
    { ...original, sourceSampleRate: 48000 },
    { ...original, sourceEndFrame: original.sourceEndFrame + 1 },
    { ...original, outputStartFrame: 129 },
    { ...original, intervals: [] },
    {
      ...original,
      intervals: [
        { ...original.intervals[0], rate: 0.85 },
        ...original.intervals.slice(1),
      ],
    },
    {
      ...original,
      intervals: [
        { ...original.intervals[0], sourceFramesPerOutputFrame: 1 },
        ...original.intervals.slice(1),
      ],
    },
    { ...original, sourceAt: () => 0 },
  ];
  for (const value of invalid)
    assert.throws(
      () => output.schedule(pcm(value, { sampleRate: 44100 })),
      RangeError,
    );
  assert.equal(context.buffers.length, 0);
});

test('enforces own byte and node budgets and returns capacity on ended', () => {
  const program = clock();
  const bytes =
    (Math.ceil(program.sourceEndFrame) +
      128 -
      (Math.floor(program.sourceStartFrame) - 128)) *
    8;
  const small = new FakeContext();
  assert.throws(
    () => renderer(small, { maxBufferBytes: bytes - 8 }).schedule(pcm(program)),
    /budget/,
  );
  assert.equal(small.buffers.length, 0);
  const context = new FakeContext();
  const output = renderer(context, { maxBufferBytes: bytes * 3, maxNodes: 2 });
  output.schedule(pcm(program));
  assert.throws(() => output.schedule(pcm(next(program))), /budget/);
  context.sources[0].end();
  assert.equal(output.stats().nodes, 0);
  assert.equal(output.stats().bufferBytes, 0);
  assert.equal(context.sources[0].buffer, null);
  assert.equal(context.sources[0].listeners.size, 0);
  assert.ok(context.sources[0].disconnected);
  assert.ok(context.gains[0].disconnected);
  output.schedule(pcm(next(program)));
  assert.equal(output.stats().nodes, 2);
  const byteContext = new FakeContext();
  const byteOutput = renderer(byteContext, { maxBufferBytes: bytes });
  byteOutput.schedule(pcm(program));
  assert.throws(() => byteOutput.schedule(pcm(next(program))), /budget/);
});

test('enforces forward scheduling time, past starts and monotonic non-overlapping output', () => {
  const context = new FakeContext();
  const output = renderer(context, { maxAheadSeconds: 0.01 });
  const first = clock();
  output.schedule(pcm(first));
  assert.throws(() => output.schedule(pcm(next(first))), /forward/);
  context.currentTime = 0.004;
  output.schedule(pcm(next(first)));
  assert.throws(() => output.schedule(pcm(first)), /past/);
  context.currentTime = 0;
  assert.throws(() => output.schedule(pcm(first)), /ordered/);
  context.sources.forEach((source) => source.end());
  assert.throws(() => output.schedule(pcm(first)), /ordered/);
  assert.equal(output.stats().scheduledAheadSeconds, 0);
  const late = new FakeContext();
  late.afterCreateBuffer = () => {
    late.currentTime = 1;
  };
  const stale = renderer(late);
  assert.throws(() => stale.schedule(pcm(first)), /past/);
  assert.equal(late.sources.length, 0);
  assert.equal(stale.stats().bufferBytes, 0);
  const noLead = new FakeContext();
  noLead.currentTime = first.outputStartFrame / 48000;
  assert.throws(() => renderer(noLead).schedule(pcm(first)), /preroll/);
  assert.equal(noLead.buffers.length, 0);
  const atZero = new FakeContext();
  assert.throws(
    () => renderer(atZero).schedule(pcm(clock({ outputStartFrame: 0 }))),
    /preroll/,
  );
  assert.equal(atZero.buffers.length, 0);
});

test('reset releases all resources and stale ended callbacks cannot affect new generations', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const first = clock();
  output.schedule(pcm(first));
  output.schedule(pcm(next(first)));
  const stale = context.sources.map((source) => source.savedEnded);
  const oldGeneration = output.stats().generation;
  output.reset();
  assert.equal(output.stats().generation, oldGeneration + 1);
  assert.equal(output.stats().lastOutputEndFrame, null);
  for (const source of context.sources) {
    assert.equal(source.buffer, null);
    assert.ok(source.disconnected);
    assert.deepEqual(source.stops.at(-1), []);
  }
  for (const gain of context.gains) {
    assert.ok(gain.disconnected);
    assert.equal(gain.gain.value, 0);
    assert.deepEqual(gain.cancellations, [0]);
  }
  output.schedule(pcm(first));
  const fresh = output.stats();
  stale.forEach((callback) => callback());
  assert.deepEqual(output.stats(), fresh);
  context.sources.at(-1).end();
  context.sources.at(-1).savedEnded();
  assert.equal(output.stats().bufferBytes, 0);
});

test('allocation and scheduling failures release ownership without committing the output watermark', () => {
  for (const stage of [
    'createBuffer',
    'copy',
    'createSource',
    'createGain',
    'buffer',
    'rate',
    'automation',
    'gate',
    'listener',
    'connect',
    'gainConnect',
    'start',
    'stop',
  ]) {
    const context = new FakeContext();
    const output = renderer(context);
    context.failAt = stage;
    assert.throws(() => output.schedule(pcm()), new RegExp(stage));
    assert.equal(output.stats().nodes, 0, stage);
    assert.equal(output.stats().bufferBytes, 0, stage);
    assert.equal(output.stats().lastOutputEndFrame, null, stage);
    for (const source of context.sources) {
      assert.ok(source.disconnected, stage);
      assert.equal(source.buffer, null, stage);
    }
    for (const gain of context.gains) assert.ok(gain.disconnected, stage);
    output.schedule(pcm());
    assert.equal(output.stats().nodes, 2, stage);
    output.dispose();
  }
});

test('dispose and context closure are terminal and cleanup failures remain visible', () => {
  const context = new FakeContext();
  const output = renderer(context);
  output.schedule(pcm());
  output.dispose();
  const terminal = output.stats();
  assert.ok(terminal.disposed);
  assert.equal(terminal.nodes, 0);
  assert.equal(context.listeners.size, 0);
  assert.deepEqual(output.dispose(), terminal);
  assert.deepEqual(output.reset(), terminal);
  assert.throws(() => output.schedule(pcm()), /disposed/);
  const closed = new FakeContext();
  const closedOutput = renderer(closed);
  closedOutput.schedule(pcm());
  closed.close();
  assert.ok(closedOutput.stats().disposed);
  assert.equal(closedOutput.stats().bufferBytes, 0);
  assert.equal(closed.listeners.size, 0);
  const broken = new FakeContext();
  const brokenOutput = renderer(broken);
  brokenOutput.schedule(pcm());
  broken.failAt = 'disconnect';
  assert.throws(() => brokenOutput.reset(), AggregateError);
  assert.equal(brokenOutput.stats().cleanupErrors, 1);
  assert.equal(brokenOutput.stats().nodes, 0);
  assert.equal(broken.sources[0].buffer, null);
});

test('validates construction limits and graph ownership without creating resources', () => {
  const context = new FakeContext();
  for (const limits of [
    null,
    [],
    { unknown: 1 },
    { maxNodes: 0 },
    { maxNodes: 1.5 },
    { maxBufferBytes: 7 },
    { maxBufferBytes: Infinity },
    { maxAheadSeconds: 0 },
    { maxAheadSeconds: NaN },
  ])
    assert.throws(() => renderer(context, limits));
  assert.throws(
    () =>
      createNaturalOutput({
        context,
        destination: { context: new FakeContext() },
      }),
    TypeError,
  );
  context.state = 'closed';
  assert.throws(() => renderer(context), /closed/);
  assert.equal(context.buffers.length, 0);
  assert.equal(context.listeners.size, 0);
});

test('truncate retains earlier nodes, shortens the spanning window and releases later windows without changing generation', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const first = clock();
  const middle = next(first);
  const last = next(middle);
  const handles = [first, middle, last].map((program) =>
    output.schedule(pcm(program)),
  );
  const before = output.stats();
  const cut = middle.outputStartFrame + 128;
  const canceledEnded = context.sources[2].savedEnded;
  const result = output.truncate(cut);
  assert.equal(result.generation, before.generation);
  assert.equal(result.lastOutputEndFrame, cut);
  assert.equal(result.nodes, 4);
  assert.equal(result.scheduledAheadSeconds, cut / 48000);
  assert.equal(
    result.bufferBytes,
    handles
      .slice(0, 2)
      .reduce(
        (total, handle) =>
          total + (handle.bufferEndFrame - handle.bufferStartFrame) * 8,
        0,
      ),
  );
  assert.deepEqual(context.sources[0].stops, [[first.outputEndFrame / 48000]]);
  assert.ok(!context.sources[0].disconnected && !context.gains[0].disconnected);
  assert.deepEqual(context.sources[1].stops.at(-1), [cut / 48000]);
  assert.deepEqual(context.sources[1].rateCancellations, [(cut - 0.5) / 48000]);
  assert.deepEqual(context.gains[1].steps.at(-1), [0, (cut - 0.5) / 48000]);
  assert.ok(!context.sources[1].disconnected && !context.gains[1].disconnected);
  assert.ok(context.sources[2].disconnected && context.gains[2].disconnected);
  assert.equal(context.sources[2].buffer, null);
  assert.deepEqual(context.sources[2].stops.at(-1), []);
  const replacement = clock({
    outputStartFrame: cut,
    sourceStartFrame: middle.sourceAt(cut),
    rateAt: () => 0.25,
  });
  output.schedule(pcm(replacement));
  const rescheduled = output.stats();
  canceledEnded();
  assert.deepEqual(output.stats(), rescheduled);
  context.sources[0].end();
  assert.equal(output.stats().nodes, 4);
  context.sources[1].end();
  assert.equal(output.stats().nodes, 2);
  context.sources[3].end();
  assert.equal(output.stats().nodes, 0);
  assert.equal(output.stats().bufferBytes, 0);
  assert.equal(output.stats().generation, before.generation);
});

test('truncate at a shared boundary keeps the ending window and immediately cancels the starting window', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const first = clock();
  output.schedule(pcm(first));
  output.schedule(pcm(next(first)));
  output.truncate(first.outputEndFrame);
  assert.equal(output.stats().nodes, 2);
  assert.deepEqual(context.sources[0].stops, [[first.outputEndFrame / 48000]]);
  assert.ok(context.sources[1].disconnected);
  output.truncate(first.outputStartFrame);
  assert.equal(output.stats().nodes, 0);
  assert.equal(output.stats().bufferBytes, 0);
  assert.equal(output.stats().generation, 0);
  assert.equal(output.stats().lastOutputEndFrame, first.outputStartFrame);
  output.schedule(pcm(first));
  assert.equal(output.stats().nodes, 2);
});

test('truncate validates alignment, active coverage, elapsed time and terminal state without mutating valid playback', () => {
  const context = new FakeContext();
  const output = renderer(context);
  assert.throws(() => output.truncate(128), /scheduled window/);
  const first = clock();
  output.schedule(pcm(first));
  output.schedule(pcm(clock({ outputStartFrame: 768 })));
  for (const value of [NaN, Infinity, -128, 129, '256', 0, 640, 1152]) {
    const before = output.stats();
    assert.throws(() => output.truncate(value), RangeError);
    assert.deepEqual(output.stats(), before);
  }
  context.currentTime = 300 / 48000;
  const before = output.stats();
  assert.throws(() => output.truncate(256), /past/);
  assert.deepEqual(output.stats(), before);
  context.currentTime = 384 / 48000;
  output.truncate(384);
  assert.equal(output.stats().generation, 0);
  output.dispose();
  assert.throws(() => output.truncate(384), /disposed/);
});

test('truncate supports an aligned cut before fractional EOF but rejects cuts outside its actual source endpoint', () => {
  const context = new FakeContext();
  const output = renderer(context);
  const program = clock({ sourceSampleRate: 48000, rateAt: () => 1 });
  const result = output.schedule(
    pcm(program, { length: 400, totalSourceFrames: 400 }),
  );
  assert.equal(result.outputEndFrame, 271.625);
  assert.throws(() => output.truncate(384), /scheduled window/);
  output.truncate(256);
  assert.equal(output.stats().lastOutputEndFrame, 256);
  assert.deepEqual(context.sources[0].stops.at(-1), [256 / 48000]);
});

test('truncate failures reset and release the remaining generation while reporting the original cause', () => {
  for (const stage of [
    'stop',
    'rateCancel',
    'gateCancel',
    'gate',
    'disconnect',
    'gainDisconnect',
  ]) {
    const context = new FakeContext();
    const output = renderer(context);
    const first = clock();
    output.schedule(pcm(first));
    output.schedule(pcm(next(first)));
    context.failAt = stage;
    assert.throws(
      () => output.truncate(256),
      (error) =>
        error instanceof AggregateError &&
        /output was reset/.test(error.message),
    );
    assert.equal(output.stats().generation, 1, stage);
    assert.equal(output.stats().nodes, 0, stage);
    assert.equal(output.stats().bufferBytes, 0, stage);
    assert.equal(output.stats().lastOutputEndFrame, null, stage);
    for (const source of context.sources)
      assert.equal(source.buffer, null, stage);
    assert.ok(
      context.gains.every((gain) => gain.gain.value === 0),
      stage,
    );
    output.schedule(pcm(first));
    assert.equal(output.stats().nodes, 2, stage);
  }
});
