import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = readFileSync(
  new URL('../site/src/scripts/demo-timeline.ts', import.meta.url),
  'utf8',
);
const outputText = stripTypeScriptTypes(source);
const { defaultPoints, formatTime } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('default demo points stay ordered with non-overlapping ramps', () => {
  for (const duration of [1, 24, 200, 86400]) {
    const points = defaultPoints(duration);
    assert.equal(points[0].t, 0);
    for (let index = 1; index < points.length; index++) {
      assert.ok(points[index].t > points[index - 1].t);
      assert.ok(points[index].t - points[index].d >= points[index - 1].t);
      assert.ok(points[index].t <= duration);
    }
  }
  assert.equal(formatTime(59.999, 2), '1:00.00');
});
