import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAudioDependencies } from '../src/audio/dependencies.mjs';

test('local decoder shares the real module and exposes only the required API', async () => {
  const [first, second] = await Promise.all([loadAudioDependencies(), loadAudioDependencies()]);
  assert.equal(first.Mediabunny, second.Mediabunny);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.Mediabunny));
  assert.deepEqual(Object.keys(first.Mediabunny).sort(), [
    'BufferSource', 'CustomPathedSource', 'EncodedPacketSink', 'HLS_FORMATS', 'Input',
  ]);
  const { BufferSource, Input, HLS_FORMATS } = first.Mediabunny;
  const source = new BufferSource(new Uint8Array(32));
  const input = new Input({source, formats: HLS_FORMATS});
  assert.ok(input instanceof Input);
  input.dispose();
});

test('cancelled activation rejects with its original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Track changed');
  controller.abort(reason);
  await assert.rejects(loadAudioDependencies({signal: controller.signal}), error => error === reason);
});

test('cancellation during module loading cannot return a stale activation', async () => {
  const controller = new AbortController();
  const pending = loadAudioDependencies({signal: controller.signal});
  const other = loadAudioDependencies();
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(typeof (await other).Mediabunny.EncodedPacketSink, 'function');
});
