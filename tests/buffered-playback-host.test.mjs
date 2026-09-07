import assert from 'node:assert/strict';
import { createBufferedPlayback as createBridge } from '../src/tempo-buffered.js';
import test from 'node:test';
import {
  deferred,
  fixture as ownerFixture,
  observe,
  settle,
} from './fixtures/playback-owner-host.mjs';

function fixture(t) {
  const prepareGate = deferred();
  let bridgeOwnerOptions;
  const f = ownerFixture(t, {
    plans: Array.from({ length: 8 }, () => ({ prepareGate })),
    onChange: (audio, state) => bridgeOwnerOptions?.onChange(audio, state),
  });
  const settings = {
    track: '/artist/track',
    rate: 0.025,
    mode: 'natural',
    wasm: true,
    schedule: null,
  };
  const calls = { fallback: 0, nativeApply: 0, failures: [] };
  const facadePlay = f.Media.prototype.play;
  const facadePause = f.Media.prototype.pause;
  const bridge = createBridge({
    prototype: f.Media.prototype,
    modules: {
      createSourceBinding: () => ({
        install() {},
        resolve: () => ({
          status: 'bound',
          sourceId: 1,
          playlistUrl: 'https://test.sndcdn.com/audio.m3u8',
        }),
        release() {},
        invalidate() {},
        dispose() {},
      }),
      createSoundCloudHostClock: () => ({ dispose() {} }),
      createPlaybackOwner(options) {
        bridgeOwnerOptions = options;
        return f.owner;
      },
    },
    graph: { hasGraph: () => true },
    readSettings: () => settings,
    media: () => [f.audio],
    applyNative: () => calls.nativeApply++,
    recoverNative() {
      settings.rate = 0.25;
      calls.nativeApply++;
    },
    onState() {},
    onFailure: (message) => calls.failures.push(message),
  });
  bridge.select(f.audio);
  t.after(() => bridge.dispose());
  return {
    ...f,
    bridge,
    settings,
    calls,
    sync(changes = {}) {
      Object.assign(settings, changes);
      return bridge.sync(f.audio);
    },
    requestPlay() {
      bridge.select(f.audio);
      bridge.sync(f.audio);
      const promise = bridge.play(f.audio, () => {
        calls.fallback++;
        return facadePlay.call(f.audio);
      });
      return Object.assign(observe(promise), { promise });
    },
    requestPause() {
      if (!bridge.pause(f.audio)) facadePause.call(f.audio);
    },
    async finishPreparation() {
      prepareGate.resolve();
      await settle();
      f.flush();
      await f.advance(f.context.currentTime + 0.3);
      await f.advance(f.context.currentTime + 0.3);
      await settle();
      f.flush();
    },
  };
}

function assertBufferedPlaying(f, play, rate, mode = 'natural') {
  assert.equal(play.status, 'fulfilled');
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.audio.paused, false);
  assert.equal(f.owner.snapshot(f.audio).requestedRate, rate);
  assert.equal(f.engines.length, 1);
  assert.equal(f.engines[0].mode, mode);
  assert.equal(f.calls.fallback, 1);
  assert.equal(f.audio.calls.filter((value) => value === 'play').length, 0);
}

test('runtime host failure restores native playback after an already completed Play', async (t) => {
  const f = fixture(t);
  const play = f.requestPlay();
  await f.finishPreparation();
  assertBufferedPlaying(f, play, 0.025);
  const failure = f.bindings[0].fail(new Error('Host method changed'));
  await settle();
  f.flush();
  await failure;
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.settings.rate, 0.25);
  assert.equal(f.calls.nativeApply, 1);
  assert.equal(f.native.get(f.audio).paused, false);
  assert.equal(f.audio.calls.filter((value) => value === 'play').length, 1);
});

for (const [name, changes] of [
  ['rate', { rate: 0.05 }],
  ['pitch mode', { mode: 'preserve' }],
]) {
  test(`pending explicit Play follows the latest ${name} during cold host discovery`, async (t) => {
    const f = fixture(t);
    const play = f.requestPlay();
    assert.equal(f.owner.owns(f.audio), false);
    assert.equal(f.native.get(f.audio).paused, true);
    f.sync(changes);
    await f.finishPreparation();
    assertBufferedPlaying(
      f,
      play,
      changes.rate ?? 0.025,
      changes.mode ?? 'natural',
    );
  });
}

test('successive pending choices retain one Play and use only the final settings', async (t) => {
  const f = fixture(t);
  const play = f.requestPlay();
  f.sync({ rate: 0.05 });
  f.sync({ mode: 'preserve' });
  f.sync({ rate: 0.025, mode: 'natural' });
  await f.finishPreparation();
  assertBufferedPlaying(f, play, 0.025);
  assert.equal(f.leases.length, 1);
});

test('a pending Play follows a return to native speed without duplicate native resume', async (t) => {
  const f = fixture(t);
  const play = f.requestPlay();
  f.sync({ rate: 0.05 });
  f.sync({ rate: 0.25 });
  await f.finishPreparation();
  assert.equal(play.status, 'fulfilled');
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.audio.paused, false);
  assert.equal(f.calls.fallback, 1);
  assert.equal(f.audio.calls.filter((value) => value === 'play').length, 1);
  assert.equal(f.engines.length, 0);
});

test('a pending native choice superseded by buffered speed plays only the final owner', async (t) => {
  const f = fixture(t);
  const play = f.requestPlay();
  f.sync({ rate: 0.25 });
  f.sync({ rate: 0.05 });
  await f.finishPreparation();
  assertBufferedPlaying(f, play, 0.05);
});

test('changing settings while paused without Play does not create playback intent', async (t) => {
  const f = fixture(t);
  f.sync();
  f.sync({ rate: 0.05, mode: 'preserve' });
  await f.finishPreparation();
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.audio.paused, true);
  assert.equal(f.engines.length, 0);
  assert.equal(f.calls.fallback, 0);
});

test('ordinary native playing intent survives capture without an explicit pending Play', async (t) => {
  const f = fixture(t);
  f.native.get(f.audio).paused = false;
  f.sync();
  f.sync({ rate: 0.05 });
  await f.finishPreparation();
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.audio.paused, false);
  assert.equal(f.native.get(f.audio).paused, true);
  assert.equal(f.engines.length, 1);
  assert.equal(f.calls.fallback, 0);
});

test('Pause cancels a carried pending Play before capture completes', async (t) => {
  const f = fixture(t);
  const play = f.requestPlay();
  f.sync({ rate: 0.05 });
  f.requestPause();
  await f.finishPreparation();
  assert.equal(play.status, 'rejected');
  assert.equal(play.error.name, 'AbortError');
  assert.equal(f.audio.paused, true);
  assert.equal(f.engines.length, 0);
  assert.equal(f.calls.fallback, 0);
});

test('Play after Pause creates a new request and cannot revive the cancelled one', async (t) => {
  const f = fixture(t);
  const oldPlay = f.requestPlay();
  f.sync({ rate: 0.05 });
  f.requestPause();
  const newPlay = f.requestPlay();
  await f.finishPreparation();
  assert.equal(oldPlay.status, 'rejected');
  assert.equal(oldPlay.error.name, 'AbortError');
  assertBufferedPlaying(f, newPlay, 0.05);
});

for (const change of ['source', 'track', 'selection round trip']) {
  test(`pending Play is cancelled by a ${change}`, async (t) => {
    const f = fixture(t);
    const play = f.requestPlay();
    f.sync({ rate: 0.05 });
    if (change === 'source') f.audio.src = 'blob:replacement';
    else if (change === 'track') {
      f.bridge.changeTrack(f.settings.track, '/artist/next');
      f.settings.track = '/artist/next';
    } else {
      f.bridge.select(new f.Media());
      f.bridge.select(f.audio);
    }
    f.sync();
    await f.finishPreparation();
    assert.equal(play.status, 'rejected');
    assert.equal(play.error.name, 'AbortError');
    assert.equal(f.audio.paused, true);
    assert.equal(f.calls.fallback, 0);
    assert.equal(f.engines.length, 0);
  });
}

test('additional Play calls coalesce across pending settings changes', async (t) => {
  const f = fixture(t);
  const first = f.requestPlay();
  f.sync({ rate: 0.05 });
  const second = f.requestPlay();
  assert.equal(second.promise, first.promise);
  await f.finishPreparation();
  assertBufferedPlaying(f, first, 0.05);
  assert.equal(second.status, 'fulfilled');
});
