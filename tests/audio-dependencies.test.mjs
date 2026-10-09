import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAudioDependencies } from '../src/audio/dependencies.mjs';
import {
  ADTS,
  HLS,
  MP4,
  MPEG_TS,
  AdtsOutputFormat,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  Output,
} from 'mediabunny';

test('local decoder shares the real module and exposes only the required API', async () => {
  const [first, second] = await Promise.all([
    loadAudioDependencies(),
    loadAudioDependencies(),
  ]);
  assert.equal(first.Mediabunny, second.Mediabunny);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.Mediabunny));
  assert.deepEqual(Object.keys(first.Mediabunny).sort(), [
    'BufferSource',
    'CustomPathedSource',
    'EncodedPacketSink',
    'HLS_FORMATS',
    'Input',
  ]);
  const { BufferSource, Input, HLS_FORMATS } = first.Mediabunny;
  assert.deepEqual(HLS_FORMATS, [HLS, MP4, ADTS, MPEG_TS]);
  assert.ok(Object.isFrozen(HLS_FORMATS));
  const source = new BufferSource(new Uint8Array(32));
  const input = new Input({ source, formats: HLS_FORMATS });
  assert.ok(input instanceof Input);
  input.dispose();
});

test('buffered decoder demuxes AAC-LC containers directly and through HLS', async () => {
  const { Mediabunny: library } = await loadAudioDependencies();
  // Packet bytes are opaque to the demuxer; this tests packaging, not audio decoding.
  const data = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);
  const decoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    numberOfChannels: 2,
    description: new Uint8Array([0x11, 0x90]),
  };
  for (const format of [
    new Mp4OutputFormat({ fastStart: 'fragmented' }),
    new AdtsOutputFormat(),
    new MpegTsOutputFormat(),
  ]) {
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const audio = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(audio);
    await output.start();
    for (let frame = 0; frame < 4; frame++)
      await audio.add(
        new EncodedPacket(data, 'key', (frame * 1024) / 48000, 1024 / 48000),
        { decoderConfig },
      );
    await output.finalize();
    for (const hls of [false, true]) {
      const playlist = new TextEncoder().encode(
        '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.085333,\nsegment\n#EXT-X-ENDLIST\n',
      );
      const source = hls
        ? new library.CustomPathedSource(
            'index.m3u8',
            (path) =>
              new library.BufferSource(
                path === 'index.m3u8' ? playlist : target.buffer,
              ),
          )
        : new library.BufferSource(target.buffer);
      const input = new library.Input({ source, formats: library.HLS_FORMATS });
      try {
        const track = await input.getPrimaryAudioTrack();
        assert.ok(track, `${format.constructor.name}, HLS=${hls}`);
        assert.equal((await track.getDecoderConfig()).codec, 'mp4a.40.2');
        const packet = await new library.EncodedPacketSink(
          track,
        ).getFirstPacket();
        // ADTS packets retain their seven-byte transport header.
        assert.ok(
          packet.data.length === data.length ||
            packet.data.length === data.length + 7,
        );
        assert.deepEqual(packet.data.slice(-data.length), data);
      } catch (error) {
        throw new Error(
          `${format.constructor.name}, HLS=${hls}: ${error.message}`,
          { cause: error },
        );
      } finally {
        input.dispose();
      }
    }
  }
});

test('cancelled activation rejects with its original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Track changed');
  controller.abort(reason);
  await assert.rejects(
    loadAudioDependencies({ signal: controller.signal }),
    (error) => error === reason,
  );
});

test('cancellation during module loading cannot return a stale activation', async () => {
  const controller = new AbortController();
  const pending = loadAudioDependencies({ signal: controller.signal });
  const other = loadAudioDependencies();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(typeof (await other).Mediabunny.EncodedPacketSink, 'function');
});
