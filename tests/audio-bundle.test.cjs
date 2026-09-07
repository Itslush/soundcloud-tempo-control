const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { bundleAudio, DEFAULT_ENTRIES } = require('../scripts/bundle-audio.cjs');

const fixtureRoot = path.resolve(__dirname, '../test-results');
fs.mkdirSync(fixtureRoot, { recursive: true });

function fixture(t, files) {
  const directory = fs.mkdtempSync(path.join(fixtureRoot, 'audio-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return (options = {}) =>
    bundleAudio({ directory, entries: ['entry.mjs'], ...options });
}

function execute(source, namespace = 'audioModules', globals = {}) {
  return vm.runInNewContext(`${source}\n${namespace}`, globals);
}

test('current audio entries expose exactly the expected factories in one isolated namespace', () => {
  const source = bundleAudio();
  const exports = execute(source);
  const expected = [
    'createRateWindow',
    'createNaturalOutput',
    'createPcmWindow',
    'createPcmSource',
    'createBufferedTransport',
    'createMediaFacade',
    'createPlaybackGate',
    'createSourceBinding',
    'createPreserveOutput',
  ].sort();
  assert.deepEqual(Object.keys(exports).sort(), expected);
  for (const name of expected) assert.equal(typeof exports[name], 'function');
  assert.ok(Object.isFrozen(exports));
  assert.equal(exports.registerPreserveProcessor, undefined);
  const clock = exports.createRateWindow({
    outputStartFrame: 0,
    sourceStartFrame: 0,
    sourceSampleRate: 48000,
    outputSampleRate: 48000,
    frameCount: 128,
    rateAt: () => 0.025,
  });
  assert.equal(clock.sourceAt(128), 128 * Math.fround(0.025));
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(
    vm.runInContext('typeof createRateWindow', context),
    'undefined',
  );
  assert.equal(vm.runInContext('typeof DEFAULT_LIMITS', context), 'undefined');
});

test('sorting requested entries is deterministic and repeated dependencies initialize once', (t) => {
  const make = fixture(t, {
    'entry.mjs':
      'import { shared } from "./shared.mjs"; export const first = shared;',
    'other.mjs':
      'import { shared } from "./shared.mjs"; export const second = shared;',
    'shared.mjs': 'globalThis.loads++; export const shared = {};',
  });
  const first = make({ entries: ['entry.mjs', 'other.mjs'] });
  assert.equal(
    first,
    make({ entries: ['other.mjs', 'entry.mjs', 'entry.mjs'] }),
  );
  const globals = { loads: 0 };
  const exports = execute(first, 'audioModules', globals);
  assert.equal(globals.loads, 1);
  assert.equal(exports.first, exports.second);
  assert.equal(exports.shared, undefined);
  assert.equal(
    bundleAudio(),
    bundleAudio({ entries: [...DEFAULT_ENTRIES].reverse() }),
  );
});

test('esbuild preserves strings, aliases, local scopes and import-adjacent comments', (t) => {
  const make = fixture(t, {
    'entry.mjs': `import { value as imported } from './nested/value.mjs';
      const value = 7;
      const $audio0 = 'untouched';
      const text = "export function fake() {} import { nope } from './missing.mjs'";
      export /* remove */ function answer() {
        function shadow(imported) { return imported + 1; }
        return [value, imported, shadow(2), text, $audio0, this];
      }
      const named = 19;
      export { named as alias };`,
    'nested/value.mjs': 'const value = 4; export { value };',
  });
  const source = make();
  assert.ok(!source.includes('/* remove */'));
  const exports = execute(source);
  const result = Reflect.apply(exports.answer, undefined, []);
  assert.equal(result[0], 7);
  assert.equal(result[1], 4);
  assert.equal(result[2], 3);
  assert.equal(
    result[3],
    "export function fake() {} import { nope } from './missing.mjs'",
  );
  assert.equal(result[4], 'untouched');
  assert.equal(result[5], undefined);
  assert.equal(exports.alias, 19);
});

test('function hoisting, classes, exported constants and prototype-named exports remain valid', (t) => {
  const make = fixture(t, {
    'entry.mjs': `const result = factory(); export function factory() { return 3; }
      export class Thing { read() { return result; } }
      const original = 42; export { original as __proto__ };
      export const first = 1, second = 2;`,
  });
  const exports = execute(make());
  assert.equal(new exports.Thing().read(), 3);
  assert.equal(exports.__proto__, 42);
  assert.equal(exports.first + exports.second, 3);
  assert.ok(Object.hasOwn(exports, '__proto__'));
});

test('relative parent imports inside the audio root are accepted', (t) => {
  const make = fixture(t, {
    'nested/entry.mjs':
      'import { n } from "../value.mjs"; export const result = n;',
    'value.mjs': 'export const n = 8;',
  });
  assert.equal(execute(make({ entries: ['nested/entry.mjs'] })).result, 8);
});

test('imports are initialized before statements even when written later in the module', (t) => {
  const make = fixture(t, {
    'entry.mjs':
      'export const result = factory(); import { factory } from "./value.mjs";',
    'value.mjs': 'export function factory() { return 11; }',
  });
  assert.equal(execute(make()).result, 11);
});

test('dependency evaluation preserves source import order', (t) => {
  const make = fixture(t, {
    'entry.mjs':
      'import { z } from "./z.mjs"; import { a } from "./a.mjs"; export const result=z+a;',
    'z.mjs': 'globalThis.order.push("z"); export const z=1;',
    'a.mjs': 'globalThis.order.push("a"); export const a=2;',
  });
  const order = [];
  assert.equal(execute(make(), 'audioModules', { order }).result, 3);
  assert.deepEqual(order, ['z', 'a']);
});

test('missing imports and source-root escapes cannot emit a bundle', (t) => {
  const missing = fixture(t, {
    'entry.mjs': 'import { x } from "./missing.mjs"; export const y=x;',
  });
  assert.throws(() => missing(), /Could not resolve/);
  const directory = fs.mkdtempSync(
    path.join(fixtureRoot, 'audio-bundle-link-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'root'));
  fs.mkdirSync(path.join(directory, 'outside'));
  fs.writeFileSync(
    path.join(directory, 'outside/module.mjs'),
    'export const x=1;',
  );
  fs.symlinkSync(
    path.join(directory, 'outside'),
    path.join(directory, 'root/linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () =>
      bundleAudio({
        directory: path.join(directory, 'root'),
        entries: ['linked/module.mjs'],
      }),
    /escapes/,
  );
  fs.writeFileSync(
    path.join(directory, 'root/entry.mjs'),
    'export { x } from "./linked/module.mjs";',
  );
  assert.throws(
    () =>
      bundleAudio({
        directory: path.join(directory, 'root'),
        entries: ['entry.mjs'],
      }),
    /escapes/,
  );
});

test('standard module cycles, re-exports and live bindings retain their semantics', (t) => {
  const make = fixture(t, {
    'entry.mjs':
      'export { value, increment } from "./state.mjs"; export const initial=1;',
    'state.mjs':
      'import { initial } from "./entry.mjs"; export let value=0; export function increment() { value += initial; }',
  });
  const exports = execute(make());
  exports.increment();
  assert.equal(exports.value, 1);
  exports.increment();
  assert.equal(exports.value, 2);
});

test('syntax failures and missing named bindings cannot emit a partial bundle', (t) => {
  for (const source of [
    'export function broken( {',
    'const x=1; const x=2; export {x};',
    'export { absent };',
    'import { absent } from "./value.mjs"; export const value=absent;',
    'export const await=1;',
  ]) {
    const make = fixture(t, {
      'entry.mjs': source,
      'value.mjs': 'export const actual=1;',
    });
    assert.throws(() => make(), undefined, source);
  }
});

test('invalid entry configuration and namespace identifiers are rejected', (t) => {
  const make = fixture(t, { 'entry.mjs': 'export const value=1;' });
  for (const entries of [[], 'entry.mjs', [null], ['../entry.mjs']])
    assert.throws(() => make({ entries }));
  for (const namespace of [
    'Object',
    'x; globalThis.pwned=1',
    'default',
    'await',
    '1bad',
    '',
  ])
    assert.throws(() => make({ namespace }));
  assert.equal(
    execute(make({ namespace: 'customAudio' }), 'customAudio').value,
    1,
  );
});
