import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateWindow } from '../src/audio/rate-clock.mjs';

const options = {
  outputStartFrame: 128,
  sourceStartFrame: 0,
  sourceSampleRate: 44100,
  outputSampleRate: 48000,
  frameCount: 128 * 100,
  rateAt: () => 0.025,
};

test('clock uses the actual Float32 AudioParam rate and both sample rates', () => {
  const clock = createRateWindow(options);
  assert.equal(clock.sourceSampleRate, options.sourceSampleRate);
  assert.equal(clock.outputSampleRate, options.outputSampleRate);
  assert.equal(clock.intervals[0].rate, Math.fround(0.025));
  assert.ok(
    Math.abs(
      clock.sourceEndFrame -
        (options.frameCount * Math.fround(0.025) * 44100) / 48000,
    ) < 1e-10,
  );
  assert.notEqual(
    clock.sourceEndFrame,
    (options.frameCount * 0.025 * 44100) / 48000,
  );
  assert.equal(clock.sourceAt(clock.outputStartFrame), 0);
  assert.equal(clock.sourceAt(clock.outputEndFrame), clock.sourceEndFrame);
  assert.equal(clock.outputAt(clock.sourceEndFrame), clock.outputEndFrame);
});

test('clock samples a source-time fade once per render quantum', () => {
  const calls = [];
  const clock = createRateWindow({
    ...options,
    rateAt: (time) => {
      calls.push(time);
      return 0.25 + time;
    },
  });
  assert.equal(calls.length, 100);
  clock.intervals.forEach((interval, index) => {
    assert.equal(calls[index], interval.sourceFrame / 44100);
    assert.equal(interval.rate, Math.fround(0.25 + calls[index]));
    if (index > 0) assert.ok(interval.rate > clock.intervals[index - 1].rate);
  });
});

test('inverse mapping and chained windows retain fractional source position', () => {
  for (const outputSampleRate of [48000, 96000]) {
    const rateAt = (time) =>
      time < 0.006 ? 0.025 : Math.min(4, 0.5 + time * 5);
    const first = createRateWindow({
      ...options,
      outputSampleRate,
      sourceStartFrame: 117.375,
      rateAt,
    });
    const second = createRateWindow({
      ...options,
      outputSampleRate,
      outputStartFrame: first.outputEndFrame,
      sourceStartFrame: first.sourceEndFrame,
      rateAt,
    });
    const combined = createRateWindow({
      ...options,
      outputSampleRate,
      sourceStartFrame: first.sourceStartFrame,
      frameCount: options.frameCount * 2,
      rateAt,
    });
    assert.ok(
      combined.intervals.some(
        (interval) => interval.rate === Math.fround(0.025),
      ),
    );
    assert.ok(
      combined.intervals.some(
        (interval) =>
          interval.sourceFrame / options.sourceSampleRate >= 0.006 &&
          interval.rate > 0.5,
      ),
    );
    assert.ok(
      new Set(combined.intervals.map((interval) => interval.rate)).size > 2,
    );
    assert.deepEqual(
      [...first.intervals, ...second.intervals],
      combined.intervals,
    );
    assert.equal(second.sourceEndFrame, combined.sourceEndFrame);
    assert.equal(
      first.sourceAt(first.outputEndFrame),
      second.sourceAt(second.outputStartFrame),
    );
    for (const clock of [first, second]) {
      assert.equal(
        clock.sourceAt(clock.outputEndFrame),
        combined.sourceAt(clock.outputEndFrame),
      );
      assert.equal(
        clock.outputAt(clock.sourceStartFrame),
        clock.outputStartFrame,
      );
      for (
        let frame = clock.outputStartFrame;
        frame < clock.outputEndFrame;
        frame += 11.375
      ) {
        const sourceFrame = clock.sourceAt(frame);
        assert.equal(sourceFrame, combined.sourceAt(frame));
        assert.equal(
          clock.outputAt(sourceFrame),
          combined.outputAt(sourceFrame),
        );
        assert.ok(Math.abs(clock.outputAt(sourceFrame) - frame) < 1e-8);
      }
    }
  }
});

test('long-track positions retain sub-thousandth-frame inverse precision across sample rates', () => {
  for (const sourceSampleRate of [8000, 44100, 48000, 96000, 384000]) {
    for (const outputSampleRate of [8000, 44100, 48000, 96000, 384000]) {
      for (const rate of [0.025, 4]) {
        const outputLimit = (outputSampleRate * 86400) / 0.025;
        const clock = createRateWindow({
          ...options,
          sourceSampleRate,
          outputSampleRate,
          sourceStartFrame: sourceSampleRate * (86400 - 2) + 0.375,
          outputStartFrame: outputLimit - 512,
          frameCount: 512,
          rateAt: () => rate,
        });
        assert.equal(clock.outputEndFrame, outputLimit);
        assert.equal(
          clock.outputAt(clock.sourceStartFrame),
          clock.outputStartFrame,
        );
        assert.equal(
          clock.outputAt(clock.sourceEndFrame),
          clock.outputEndFrame,
        );
        assert.ok(clock.sourceEndFrame > clock.sourceStartFrame);
        clock.intervals
          .slice(1)
          .forEach((interval, index) =>
            assert.ok(
              interval.sourceFrame > clock.intervals[index].sourceFrame,
            ),
          );
        for (const offset of [
          0, 0.125, 11.375, 127.875, 128, 130.25, 511.875, 512,
        ]) {
          const frame = clock.outputStartFrame + offset;
          assert.ok(
            Math.abs(clock.outputAt(clock.sourceAt(frame)) - frame) < 0.001,
            JSON.stringify({
              sourceSampleRate,
              outputSampleRate,
              rate,
              offset,
            }),
          );
        }
      }
    }
  }
});

test('clock rejects positions beyond its source and output precision domain', () => {
  assert.throws(
    () =>
      createRateWindow({
        ...options,
        sourceStartFrame: 2 ** 52,
        sourceSampleRate: 8000,
        outputSampleRate: 384000,
        frameCount: 256,
      }),
    /24-hour clock limit/,
  );
  const sourceLimit = options.sourceSampleRate * 86400;
  const outputLimit = (options.outputSampleRate * 86400) / 0.025;
  assert.throws(
    () => createRateWindow({ ...options, sourceStartFrame: sourceLimit + 0.5 }),
    /24-hour clock limit/,
  );
  assert.throws(
    () => createRateWindow({ ...options, sourceStartFrame: sourceLimit - 1 }),
    /24-hour clock limit/,
  );
  assert.throws(
    () =>
      createRateWindow({
        ...options,
        outputStartFrame: outputLimit,
        frameCount: 128,
      }),
    /40-day clock limit/,
  );
  assert.throws(
    () =>
      createRateWindow({
        ...options,
        outputStartFrame: outputLimit - 128,
        frameCount: 256,
      }),
    /40-day clock limit/,
  );
  const lastQuantum = createRateWindow({
    ...options,
    sourceSampleRate: 48000,
    outputSampleRate: 48000,
    sourceStartFrame: 48000 * 86400 - 128,
    outputStartFrame: outputLimit - 128,
    frameCount: 128,
    rateAt: () => 1,
  });
  assert.equal(lastQuantum.sourceEndFrame, 48000 * 86400);
  assert.equal(lastQuantum.outputEndFrame, outputLimit);
});

test('two-second windows near the source limit accumulate less than one output frame of rounding', () => {
  for (const sourceSampleRate of [8000, 44100, 48000, 96000, 384000]) {
    for (const outputSampleRate of [8000, 44100, 48000, 96000, 384000]) {
      for (const rate of [0.025, 0.25, 1, 4]) {
        const frameCount = Math.floor((outputSampleRate * 2) / 128) * 128;
        const clock = createRateWindow({
          ...options,
          sourceSampleRate,
          outputSampleRate,
          frameCount,
          sourceStartFrame: sourceSampleRate * (86400 - 10) + 0.375,
          rateAt: () => rate,
        });
        const slope = (Math.fround(rate) * sourceSampleRate) / outputSampleRate;
        const error =
          Math.abs(
            clock.sourceEndFrame - clock.sourceStartFrame - frameCount * slope,
          ) / slope;
        assert.ok(
          error < 1,
          JSON.stringify({ sourceSampleRate, outputSampleRate, rate, error }),
        );
      }
    }
  }
});

test('clock rejects unsupported rates, unbounded windows and out-of-window reads', () => {
  for (const rate of [0, -0.025, 0.0249, 4.01, NaN, Infinity, '1'])
    assert.throws(
      () => createRateWindow({ ...options, rateAt: () => rate }),
      RangeError,
    );
  for (const change of [
    { frameCount: 1 },
    { frameCount: 128 * 1000 },
    { outputStartFrame: 1 },
    { sourceStartFrame: Infinity },
    { outputSampleRate: 0 },
    { sourceSampleRate: 44100.5 },
  ])
    assert.throws(
      () => createRateWindow({ ...options, ...change }),
      RangeError,
    );
  const clock = createRateWindow(options);
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => clock.sourceAt(value), RangeError);
    assert.throws(() => clock.outputAt(value), RangeError);
  }
  assert.throws(() => clock.sourceAt(clock.outputEndFrame + 1), RangeError);
  assert.throws(() => clock.outputAt(clock.sourceEndFrame + 1), RangeError);
  assert.ok(
    Object.isFrozen(clock) &&
      Object.isFrozen(clock.intervals) &&
      Object.isFrozen(clock.intervals[0]),
  );
});
