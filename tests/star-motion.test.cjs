const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runInNewContext } = require('node:vm');
const { buildSync } = require('esbuild');

test('website stars drift at 1.5x, turn smoothly, wrap, and pause without jumps', () => {
  const code = buildSync({
    entryPoints: ['site/src/scripts/star-motion.ts'],
    bundle: true,
    write: false,
    format: 'iife',
  }).outputFiles[0].text;
  let point = [0, 0],
    visible,
    active,
    next = 0,
    time = 0,
    seed = 7;
  const frames = new Map(),
    listeners = {};
  const preferences = new Map();
  const pattern = {
    setAttribute: (_, value) => {
      point = value.match(/[-\d.]+/g).map(Number);
    },
  };
  const field = {
    querySelector: () => pattern,
    toggleAttribute: (_, value) => {
      active = value;
    },
  };
  const document = {
    hidden: false,
    querySelector: (selector) => (selector === '.space-accent' ? field : null),
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  runInNewContext(code, {
    document,
    window: {
      requestAnimationFrame: (fn) => {
        frames.set(++next, fn);
        return next;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    },
    Math: Object.assign(Object.create(Math), {
      random: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
    }),
    matchMedia: (query) => {
      const preference = {
        matches: false,
        addEventListener: (_, fn) => {
          preference.change = fn;
        },
      };
      preferences.set(query, preference);
      return preference;
    },
    IntersectionObserver: class {
      constructor(fn) {
        visible = fn;
      }
      observe() {}
    },
  });
  function step() {
    time += 1000 / 60;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(time));
    assert.ok(frames.size <= 1);
  }
  visible([{ isIntersecting: true }]);
  step();
  let lastAngle,
    turning = 0,
    wraps = 0;
  for (let i = 0; i < 120000; i++) {
    const before = point;
    step();
    const delta = point.map((value, axis) => {
      const tile = [960, 840][axis],
        diff = value - before[axis];
      if (Math.abs(diff) > tile / 2) wraps++;
      return diff - Math.round(diff / tile) * tile;
    });
    assert.ok(Math.abs(Math.hypot(...delta) - 10 / 60) < 1e-8);
    const angle = Math.atan2(delta[1], delta[0]);
    if (lastAngle !== undefined) {
      const turn = Math.abs(
        Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle)),
      );
      assert.ok(turn < 0.02, 'direction changed abruptly');
      turning += turn;
    }
    lastAngle = angle;
  }
  assert.ok(turning > 3, 'direction never meaningfully changed');
  assert.ok(wraps > 0, 'test did not reach a tile boundary');
  for (const preference of preferences.values()) {
    preference.matches = true;
    preference.change();
    const before = point;
    step();
    assert.equal(point, before);
    assert.equal(active, false);
    preference.matches = false;
    preference.change();
    step();
    assert.equal(point[0], before[0]);
  }
  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(frames.size, 0);
  document.hidden = false;
  listeners.visibilitychange();
  listeners.pagehide();
  assert.equal(frames.size, 0);
  listeners.pageshow();
  step();
  assert.equal(frames.size, 1);
  visible([{ isIntersecting: false }]);
  assert.equal(frames.size, 0);
});
