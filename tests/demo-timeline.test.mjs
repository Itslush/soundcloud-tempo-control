import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(
  new URL('../site/src/scripts/demo-timeline.ts', import.meta.url),
  'utf8',
);
const outputText = stripTypeScriptTypes(source);
const { defaultPoints, EditHistory, formatTime, rateAt, timeTicks } =
  await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  );

test('zoom ticks retain distinct labels across minute boundaries and close windows', () => {
  for (const [start, end] of [
    [0, 24],
    [17.625, 18.375],
    [59.75, 60.25],
    [0.01, 0.04],
    [0.00001, 0.00004],
  ]) {
    const { ticks, precision } = timeTicks(start, end, 3);
    const labels = ticks.map((value) => formatTime(value, precision));
    assert.equal(new Set(labels).size, labels.length);
    assert.equal(ticks[0], start);
    assert.equal(ticks.at(-1), end);
  }
  assert.equal(formatTime(59.999, 2), '1:00.00');
});

test('tempo curves hold endpoints and interpolate smoothly without overshoot', () => {
  const points = defaultPoints(24);
  assert.equal(rateAt(points, 0), 1);
  assert.equal(rateAt(points, 8), 0.75);
  assert.equal(rateAt(points, 18), 0.9);
  assert.equal(rateAt(points, 30), 0.9);
  for (let time = 0; time <= 24; time += 0.01)
    assert.ok(rateAt(points, time) >= 0.75 && rateAt(points, time) <= 1);
  const short = defaultPoints(0.001);
  assert.ok(short[0].t < short[1].t && short[1].t < short[2].t);
});

test('history preserves grouped edits, supports branching and bounds memory', () => {
  const points = defaultPoints(24);
  const history = new EditHistory(points);
  points[2].r = 1.2;
  points[2].r = 1.5;
  history.commit(points);
  assert.equal(history.move('undo')[2].r, 0.9);
  assert.equal(history.available('undo'), false);
  assert.equal(history.move('redo')[2].r, 1.5);
  history.move('undo');
  points[2].r = 0.8;
  history.commit(points);
  assert.equal(history.available('redo'), false);
  for (let i = 0; i < 100; i++) {
    points[2].r = i;
    history.commit(points);
  }
  let count = 0;
  while (history.move('undo')) count++;
  assert.equal(count, 64);
  history.reset(defaultPoints(24));
  assert.equal(history.available('undo'), false);
  assert.equal(history.available('redo'), false);
});
