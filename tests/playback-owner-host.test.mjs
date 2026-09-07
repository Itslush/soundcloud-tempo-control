import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deferred,
  settle,
  observe,
  settings,
  fixture,
} from './fixtures/playback-owner-host.mjs';

test('rejected and malformed host preparation never acquire or park native media', async (t) => {
  for (const plan of [
    { prepareError: new Error('Host discovery failed') },
    { prepared: null },
    { prepared: {} },
    { prepared: { bind: 1 } },
  ]) {
    const f = fixture(t, { plans: [plan] });
    await assert.rejects(f.owner.use(f.audio, settings()));
    assert.equal(f.leases.length, 0);
    assert.equal(f.owner.owns(f.audio), false);
    assert.deepEqual(f.audio.calls, []);
    assert.equal(f.audio.playbackRate, 1);
  }
});

test('late preparation after release, disposal or either source replacement cannot activate', async (t) => {
  for (const invalidation of ['release', 'dispose', 'src', 'srcObject']) {
    const prepareGate = deferred();
    const f = fixture(t, { plans: [{ prepareGate }] });
    const pending = observe(f.owner.use(f.audio, settings()));
    assert.equal(f.preparations.length, 1);
    if (invalidation === 'release') await f.owner.release(f.audio);
    else if (invalidation === 'dispose') await f.owner.dispose();
    else f.audio[invalidation] = invalidation === 'src' ? 'blob:next' : {};
    prepareGate.resolve();
    await pending.done;
    assert.equal(pending.error?.name, 'AbortError');
    assert.equal(f.leases.length, 0);
    assert.equal(f.bindings.length, 0);
    assert.deepEqual(f.audio.calls, []);
  }
});

test('preparation finishing after context closure leaves no host binding or facade', async (t) => {
  const prepareGate = deferred();
  const f = fixture(t, { plans: [{ prepareGate }] });
  const pending = observe(f.owner.use(f.audio, settings()));
  f.context.state = 'closed';
  prepareGate.resolve();
  await pending.done;
  await settle();
  assert.equal(pending.status, 'rejected');
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.bindings.length, 0);
});

test('only the newest prepared request may acquire the graph', async (t) => {
  const first = deferred();
  const second = deferred();
  const f = fixture(t, {
    plans: [{ prepareGate: first }, { prepareGate: second }],
  });
  const older = observe(f.owner.use(f.audio, settings()));
  const newer = observe(f.owner.use(f.audio, settings('preserve')));
  first.resolve();
  await older.done;
  assert.equal(older.error?.name, 'AbortError');
  assert.equal(f.leases.length, 0);
  second.resolve();
  await newer.done;
  assert.equal(newer.status, 'fulfilled');
  assert.equal(f.leases.length, 1);
  assert.equal(f.bindings.length, 1);
});

test('concurrent preparation rechecks the ownership limit before acquiring each graph', async (t) => {
  const gates = [deferred(), deferred(), deferred()];
  const f = fixture(t, {
    plans: gates.map((prepareGate) => ({ prepareGate })),
  });
  const media = [f.audio, new f.Media(), new f.Media()];
  const pending = media.map((audio) => observe(f.owner.use(audio, settings())));
  assert.equal(f.preparations.length, 3);
  assert.equal(f.leases.length, 0);
  for (let index = 0; index < gates.length; index++) {
    gates[index].resolve();
    await pending[index].done;
  }
  assert.equal(pending[0].status, 'fulfilled');
  assert.equal(pending[1].status, 'fulfilled');
  assert.match(pending[2].error?.message, /ownership limit/);
  assert.equal(f.leases.length, 2);
  assert.equal(f.bindings.length, 2);
  assert.equal(f.owner.owns(media[2]), false);
});

test('slow preparation refreshes native position and respects a newer pause request', async (t) => {
  const prepareGate = deferred();
  const f = fixture(t, { plans: [{ prepareGate }] });
  f.native.get(f.audio).paused = false;
  const pending = f.owner.use(f.audio, settings());
  f.native.get(f.audio).currentTime = 12.75;
  f.owner.pause(f.audio);
  prepareGate.resolve();
  const state = await pending;
  assert.equal(state.position, 12.75);
  assert.equal(state.paused, true);
  assert.equal(f.sources.length, 0);
  assert.equal(f.engines.length, 0);
  assert.deepEqual(f.audio.calls, ['pause']);
});

test('slow preparation preserves current native playing intent when no pause intervenes', async (t) => {
  const prepareGate = deferred();
  const f = fixture(t, { plans: [{ prepareGate }] });
  const pending = f.owner.use(f.audio, settings());
  f.native.get(f.audio).currentTime = 8.5;
  f.native.get(f.audio).paused = false;
  prepareGate.resolve();
  const state = await pending;
  assert.equal(state.position, 8.5);
  assert.equal(state.paused, false);
  assert.equal(f.native.get(f.audio).paused, true);
});

test('host binding precedes playback events and receives the same state as the facade', async (t) => {
  const f = fixture(t);
  const observed = [];
  for (const name of ['play', 'playing', 'pause', 'seeked', 'ratechange'])
    f.audio.addEventListener(name, () => {
      observed.push(name);
      assert.equal(f.bindings.at(-1).active, true);
      assert.equal(
        f.bindings.at(-1).updates.at(-1).snapshot.paused,
        f.audio.paused,
      );
    });
  await f.owner.use(f.audio, settings());
  await f.play();
  f.audio.pause();
  f.audio.currentTime = 10;
  await settle();
  f.flush();
  await f.owner.use(f.audio, settings('natural', 0.075));
  f.flush();
  const updates = f.bindings[0].updates;
  assert.ok(updates.some((value) => value.snapshot.state === 'playing'));
  assert.equal(updates.at(-1).snapshot.position, 10);
  assert.equal(updates.at(-1).snapshot.requestedRate, 0.075);
  for (const value of updates) {
    assert.equal(value.snapshot.position, value.mediaPosition);
    assert.equal(value.snapshot.paused, value.mediaPaused);
  }
  assert.ok(observed.includes('play'));
  assert.ok(observed.includes('playing'));
  assert.ok(f.events.indexOf('host-bind') < f.events.indexOf('host-update'));
});

test('mode changes retain frozen buffered position and intent through host preparation', async (t) => {
  const prepareGate = deferred();
  const f = fixture(t, { plans: [{}, { prepareGate }] });
  await f.owner.use(f.audio, settings());
  await f.play();
  const position = f.audio.currentTime;
  const switching = f.owner.use(f.audio, settings('preserve'));
  await settle();
  assert.equal(f.preparations.length, 2);
  f.native.get(f.audio).currentTime = 77;
  assert.equal(f.native.get(f.audio).paused, true);
  prepareGate.resolve();
  const state = await switching;
  assert.equal(state.position, position);
  assert.equal(state.paused, false);
  assert.equal(f.leases.length, 2);
});

test('pause during replacement host preparation overrides retained buffered playing intent', async (t) => {
  const prepareGate = deferred();
  const f = fixture(t, { plans: [{}, { prepareGate }] });
  await f.owner.use(f.audio, settings());
  await f.play();
  const position = f.audio.currentTime;
  const switching = f.owner.use(f.audio, settings('preserve'));
  await settle();
  assert.equal(f.preparations.length, 2);
  f.owner.pause(f.audio);
  prepareGate.resolve();
  const state = await switching;
  assert.equal(state.position, position);
  assert.equal(state.paused, true);
  assert.equal(f.engines.length, 1);
});

test('a host bind exception keeps graph cleanup as a barrier before retry', async (t) => {
  const nativeReleaseGate = deferred();
  const f = fixture(t, {
    nativeReleaseGate,
    plans: [{ bindError: new Error('Bind failed') }, {}],
  });
  await assert.rejects(f.owner.use(f.audio, settings()), /Bind failed/);
  const retry = observe(f.owner.use(f.audio, settings()));
  await settle();
  assert.equal(f.leases.length, 1);
  assert.equal(f.bindings.length, 0);
  assert.equal(retry.status, 'pending');
  nativeReleaseGate.resolve();
  await retry.done;
  assert.equal(retry.status, 'fulfilled');
  assert.equal(f.leases.length, 2);
});

test('initial host update failure rejects setup and restores acquired ownership', async (t) => {
  const error = new Error('Initial host update failed');
  const f = fixture(t, { plans: [{ initialUpdateError: error }] });
  await assert.rejects(f.owner.use(f.audio, settings()), error);
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.liveGraphs.size, 0);
  assert.equal(f.bindings[0].releases, 1);
  assert.equal(f.sources.length, 0);
});

test('invalid bound host shapes reject ownership and release any provided cleanup', async (t) => {
  for (const invalid of [
    null,
    { update: null },
    { active: 'true' },
    { release: null },
  ]) {
    let releases = 0;
    const host =
      invalid === null
        ? null
        : {
            active: true,
            update() {},
            release() {
              releases++;
            },
            restoration: Promise.resolve(),
            ...invalid,
          };
    const f = fixture(t, { plans: [{ prepared: { bind: () => host } }] });
    await assert.rejects(
      f.owner.use(f.audio, settings()),
      /Invalid host clock binding/,
    );
    await settle();
    assert.equal(f.owner.owns(f.audio), false);
    assert.equal(f.liveGraphs.size, 0);
    assert.equal(f.audio.playbackRate, 1);
    assert.equal(f.sources.length, 0);
    if (typeof host?.release === 'function') assert.equal(releases, 1);
  }
});

test('native handback completes before host restoration and replacement preparation', async (t) => {
  const nativeReleaseGate = deferred();
  const restoreGate = deferred();
  const f = fixture(t, { nativeReleaseGate, plans: [{ restoreGate }, {}] });
  await f.owner.use(f.audio, settings());
  const release = observe(f.owner.release(f.audio));
  const replacement = observe(f.owner.use(f.audio, settings('preserve')));
  await settle();
  assert.equal(f.bindings[0].releases, 0);
  assert.equal(f.preparations.length, 1);
  assert.equal(release.status, 'pending');
  nativeReleaseGate.resolve();
  await settle();
  assert.equal(f.liveGraphs.size, 0);
  assert.equal(f.bindings[0].releases, 1);
  assert.equal(release.status, 'pending');
  assert.equal(replacement.status, 'pending');
  assert.equal(f.preparations.length, 1);
  restoreGate.resolve();
  await Promise.all([release.done, replacement.done]);
  assert.equal(release.status, 'fulfilled');
  assert.equal(replacement.status, 'fulfilled');
  assert.ok(
    f.events.indexOf('native-released') < f.events.indexOf('host-release'),
  );
  assert.ok(
    f.events.indexOf('host-restored') < f.events.lastIndexOf('prepare'),
  );
});

test('unexpected host update exceptions close ownership and publish a visible failure', async (t) => {
  const f = fixture(t);
  await f.owner.use(f.audio, settings());
  await f.play();
  const error = new Error('Host update failed');
  f.bindings[0].updateError = error;
  f.owner.pause(f.audio);
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.liveGraphs.size, 0);
  assert.ok(f.errors.includes(error));
  assert.ok(
    f.changes.some(
      (value) => value.state?.state === 'error' && value.state.error === error,
    ),
  );
  assert.equal(f.bindings[0].releases, 1);
});

test('an update returning false only detaches when host ownership is inactive', async (t) => {
  for (const active of [true, false]) {
    const f = fixture(t);
    await f.owner.use(f.audio, settings());
    f.bindings[0].returnFalse = true;
    f.bindings[0].active = active;
    f.owner.pause(f.audio);
    await settle();
    assert.equal(f.owner.owns(f.audio), active);
    assert.equal(f.liveGraphs.has(f.audio), active);
    assert.equal(f.bindings[0].releases, active ? 0 : 1);
    assert.deepEqual(f.errors, []);
    if (!active) assert.equal(f.leases[0].releases[0].restore, false);
  }
});

test('reentrant host failure awaits only native handback and cannot deadlock restoration', async (t) => {
  const nativeReleaseGate = deferred();
  const restoreGate = deferred();
  const f = fixture(t, { nativeReleaseGate, plans: [{ restoreGate }] });
  await f.owner.use(f.audio, settings());
  await f.play();
  const error = new Error('Host chain changed');
  const hostRestoration = observe(f.bindings[0].fail(error));
  await settle();
  const release = observe(f.owner.release(f.audio));
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(hostRestoration.status, 'pending');
  assert.equal(release.status, 'pending');
  nativeReleaseGate.resolve();
  await settle();
  assert.ok(f.events.includes('failure-native-returned'));
  assert.equal(hostRestoration.status, 'pending');
  assert.equal(release.status, 'pending');
  assert.equal(f.native.get(f.audio).paused, true);
  assert.ok(f.errors.includes(error));
  assert.ok(f.changes.some((value) => value.state?.error === error));
  restoreGate.resolve();
  await settle();
  assert.equal(hostRestoration.status, 'fulfilled');
  assert.equal(release.status, 'fulfilled');
  assert.equal(f.liveGraphs.size, 0);
  assert.equal(f.bindings[0].releases, 1);
});

test('failed native handback is reported without poisoning host restoration or cleanup retry', async (t) => {
  const nativeError = new Error('Native handback failed');
  const options = { nativeReleaseError: nativeError };
  const f = fixture(t, options);
  await f.owner.use(f.audio, settings());
  await f.play();
  const hostError = new Error('Host binding failed');
  const restoration = observe(f.bindings[0].fail(hostError));
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.liveGraphs.has(f.audio), true);
  assert.equal(restoration.status, 'fulfilled');
  await assert.rejects(f.owner.release(f.audio), /cleanup failed/);
  assert.equal(f.leases.length, 1);
  options.nativeReleaseError = null;
  const released = await f.owner.release(f.audio);
  assert.equal(released.restored, true);
  assert.equal(f.liveGraphs.has(f.audio), false);
  assert.equal(f.bindings[0].releases, 1);
  assert.ok(f.errors.includes(hostError));
  await f.owner.use(f.audio, settings('preserve'));
  assert.equal(f.leases.length, 2);
});

test('source changes prevent old host updates and restoration writes', async (t) => {
  const nativeReleaseGate = deferred();
  const restoreGate = deferred();
  const f = fixture(t, { nativeReleaseGate, plans: [{ restoreGate }, {}] });
  await f.owner.use(f.audio, settings());
  const old = f.bindings[0];
  const updates = old.updates.length;
  f.audio.src = 'blob:replacement';
  const next = observe(
    f.owner.use(f.audio, settings('natural', 0.025, '/artist/next')),
  );
  await settle();
  assert.equal(old.callbacks.sourceMatches(), false);
  assert.equal(old.updates.length, updates);
  nativeReleaseGate.resolve();
  await settle();
  assert.equal(next.status, 'pending');
  restoreGate.resolve();
  await next.done;
  assert.equal(next.status, 'fulfilled');
  assert.equal(old.restored, false);
  assert.equal(old.updates.length, updates);
  assert.equal(f.leases[0].releases[0].restore, false);
  assert.equal(f.bindings[1].callbacks.sourceMatches(), true);
});

test('late failure callbacks from a replaced host cannot close or update the new owner', async (t) => {
  const f = fixture(t);
  await f.owner.use(f.audio, settings());
  const old = f.bindings[0];
  f.audio.src = 'blob:replacement';
  await f.owner.use(
    f.audio,
    settings('preserve', 0.025, '/artist/replacement'),
  );
  const changed = f.changes.length;
  const updates = f.bindings[1].updates.length;
  const errors = f.errors.length;
  await old.callbacks.onFailure(new Error('Late old failure'));
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.changes.length, changed);
  assert.equal(f.bindings[1].updates.length, updates);
  assert.equal(f.errors.length, errors);
  assert.equal(f.leases.length, 2);
  assert.equal(f.liveGraphs.has(f.audio), true);
});

test('failed host restoration remains counted and cannot be replaced as if cleaned up', async (t) => {
  const firstError = new Error('Host restoration failed');
  const f = fixture(t, {
    plans: [{ restoreError: firstError }, { restoreError: firstError }],
  });
  await f.owner.use(f.audio, settings());
  await assert.rejects(f.owner.release(f.audio), /cleanup failed/);
  assert.equal(f.liveGraphs.size, 0);
  await assert.rejects(f.owner.use(f.audio, settings('preserve')));
  assert.equal(f.leases.length, 1);
  const second = new f.Media();
  await f.owner.use(second, settings());
  await assert.rejects(f.owner.release(second), /cleanup failed/);
  await assert.rejects(
    f.owner.use(new f.Media(), settings()),
    /ownership limit/,
  );
  assert.equal(f.leases.length, 2);
  await assert.rejects(f.owner.dispose(), /disposal failed/);
});

test('dispose waits for outstanding host restoration and never restarts native playback', async (t) => {
  const restoreGate = deferred();
  const f = fixture(t, { plans: [{ restoreGate }] });
  await f.owner.use(f.audio, settings());
  await f.play();
  const disposing = observe(f.owner.dispose());
  await settle();
  assert.equal(f.owner.owns(f.audio), false);
  assert.equal(f.liveGraphs.size, 0);
  assert.equal(disposing.status, 'pending');
  assert.equal(f.bindings[0].releases, 1);
  assert.equal(f.leases[0].releases[0].restore, false);
  restoreGate.resolve();
  await disposing.done;
  assert.equal(disposing.status, 'fulfilled');
  assert.deepEqual(f.audio.calls, ['pause']);
  assert.equal(f.engines[0].providerDisposed, 1);
  assert.equal(f.engines[0].outputDisposed, 1);
});

test('without a host adapter paused ownership remains synchronous and source loading stays lazy', async (t) => {
  const f = fixture(t, { noHost: true });
  const starting = f.owner.use(f.audio, settings());
  assert.equal(f.owner.owns(f.audio), true);
  assert.equal(f.audio.playbackRate, 0.025);
  await starting;
  assert.equal(f.preparations.length, 0);
  assert.equal(f.bindings.length, 0);
  assert.equal(f.sources.length, 0);
  await f.owner.release(f.audio);
  assert.equal(f.audio.playbackRate, 1);
  assert.equal(f.liveGraphs.size, 0);
});
