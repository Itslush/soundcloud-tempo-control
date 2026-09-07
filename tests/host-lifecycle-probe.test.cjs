const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(
  require.resolve('./fixtures/host-lifecycle-probe.js'),
  'utf8',
);

test('formatted lifecycle probe composes with the host inspector', () => {
  const inspector = fs.readFileSync(
    require.resolve('./fixtures/host-clock-probe.js'),
    'utf8',
  );
  const expression = (value) => value.trim().replace(/;$/, '');
  assert.doesNotThrow(
    () =>
      new vm.Script(`() => (${expression(inspector)})(${expression(code)})`),
  );
});

function fixture() {
  const calls = [];
  class BasePlayer {
    kill(...args) {
      calls.push({ receiver: this, args });
      return 17;
    }
    _triggerError(error) {
      throw error;
    }
  }
  const context = vm.createContext({ performance: { now: () => 42 } });
  const install = vm.runInContext(
    `(${code.trim().replace(/;$/, '')})`,
    context,
  );
  const original = Object.getOwnPropertyDescriptor(
    BasePlayer.prototype,
    'kill',
  );
  install({ c: { 100: { exports: { BasePlayer } } } });
  return { BasePlayer, calls, original, probe: context.hostLifecycleProbe };
}

test('lifecycle observation preserves receiver, arguments, return and thrown identity', () => {
  const { BasePlayer, calls, probe } = fixture();
  const player = new BasePlayer();
  const argument = {};
  assert.equal(player.kill(argument), 17);
  assert.equal(calls[0].receiver, player);
  assert.equal(calls[0].args[0], argument);
  const error = new Error('host failure');
  assert.throws(
    () => player._triggerError(error),
    (value) => value === error,
  );
  assert.equal(probe.snapshot().events.length, 2);
});

test('lifecycle history is bounded without suppressing host calls', () => {
  const { BasePlayer, calls, probe } = fixture();
  const player = new BasePlayer();
  for (let i = 0; i < 40; i++) player.kill();
  assert.equal(calls.length, 40);
  assert.equal(probe.snapshot().events.length, 32);
  assert.equal(probe.snapshot().dropped, 8);
});

test('lifecycle cleanup restores the original descriptor', () => {
  const { BasePlayer, original, probe } = fixture();
  assert.equal(probe.restore(), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(BasePlayer.prototype, 'kill'),
    original,
  );
});

test('lifecycle cleanup preserves later host replacements', () => {
  const { BasePlayer, probe } = fixture();
  const replacement = () => 23;
  BasePlayer.prototype.kill = replacement;
  assert.equal(probe.restore(), true);
  assert.equal(BasePlayer.prototype.kill, replacement);
});
