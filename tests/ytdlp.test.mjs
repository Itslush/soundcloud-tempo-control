import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createExtractor } from '../server/ytdlp.mjs';

function fixture(action, timeout = 1000) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    child.killed = true;
    setImmediate(() => child.emit('close', null));
  };
  const calls = [];
  const extractor = createExtractor({
    command: process.execPath,
    timeout,
    launch: (...args) => {
      calls.push(args);
      setImmediate(() => action(child));
      return child;
    },
  });
  return { child, calls, extractor };
}

test('runs isolated yt-dlp with a fixed argument list and no shell', async () => {
  const { calls, extractor } = fixture((child) => {
    child.stdout.write('{"title":"');
    child.stdout.write('Track"}\n');
    child.emit('close', 0);
  });
  assert.deepEqual(await extractor.extract('https://soundcloud.com/a/b'), {
    title: 'Track',
  });
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(args.slice(0, 3), ['-I', '-m', 'yt_dlp']);
  assert.deepEqual(args.slice(-2), ['--', 'https://soundcloud.com/a/b']);
  for (const option of [
    '--ignore-config',
    '--no-plugin-dirs',
    '--no-cache-dir',
    '--no-geo-bypass',
    '--no-js-runtimes',
    '--skip-download',
  ])
    assert(args.includes(option));
  assert.equal(args[args.indexOf('--use-extractors') + 1], 'Soundcloud$');
});

test('kills extraction when the caller aborts', async () => {
  const { child, extractor } = fixture(() => {});
  const controller = new AbortController();
  const result = extractor.extract(
    'https://soundcloud.com/a/b',
    controller.signal,
  );
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(child.killed, true);
});

test('does not launch for an already cancelled request', () => {
  const { calls, extractor } = fixture(() => {});
  assert.throws(() => extractor.extract('x', AbortSignal.abort()), {
    name: 'AbortError',
  });
  assert.equal(calls.length, 0);
});

test('kills a timed-out extraction', async () => {
  const { child, extractor } = fixture(() => {}, 20);
  await assert.rejects(extractor.extract('x'), { status: 504 });
  assert.equal(child.killed, true);
});

test('bounds stdout and stderr without returning raw upstream output', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const { child, extractor } = fixture((child) =>
      child[stream].write(Buffer.alloc(524289, 65)),
    );
    await assert.rejects(extractor.extract('x'), { status: 502 });
    assert.equal(child.killed, true);
  }
});

test('sanitizes process failures into useful status codes', async () => {
  for (const [message, status] of [
    ['HTTP Error 429', 429],
    ['HTTP Error 404', 404],
    ['HTTP Error 403', 403],
    ['No module named yt_dlp', 503],
    ['private track', 403],
    ['unhandled secret token', 502],
  ]) {
    const { extractor } = fixture((child) => {
      child.stderr.write(message);
      child.emit('close', 1);
    });
    await assert.rejects(
      extractor.extract('x'),
      (error) =>
        error.status === status && !error.message.includes('secret token'),
    );
  }
});

test('handles missing executable and malformed JSON', async () => {
  const missing = fixture((child) =>
    child.emit(
      'error',
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    ),
  );
  await assert.rejects(missing.extractor.extract('x'), { status: 503 });
  const broken = fixture((child) => {
    child.stdout.write('invalid');
    child.emit('close', 0);
  });
  await assert.rejects(broken.extractor.extract('x'), { status: 502 });
});
