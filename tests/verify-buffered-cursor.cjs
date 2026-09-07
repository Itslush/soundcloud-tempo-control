const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor', 'signalsmith');
const metadata = JSON.parse(
  readFileSync(path.join(vendor, 'signalsmith.json'), 'utf8'),
);
const patch = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures', 'buffered-cursor-patch.json'),
    'utf8',
  ),
);
const bytes = readFileSync(path.join(vendor, metadata.file));
const checksum = createHash('sha256').update(bytes).digest('hex');

assert.equal(checksum, metadata.sha256, 'Pinned vendor checksum changed');
assert.equal(
  checksum,
  patch.sha256,
  'Candidate targets a different vendor checksum',
);
assert.equal(
  metadata.revision,
  patch.revision,
  'Candidate targets a different vendor revision',
);
assert.equal(
  patch.replacements.length,
  2,
  'Expected the two-line cursor candidate',
);

const source = bytes.toString('utf8');
let candidateSource = source;

for (const { find, replace, count } of patch.replacements) {
  assert.equal(count, 1, 'Each guarded replacement must occur once');
  assert.equal(
    candidateSource.split(find).length - 1,
    count,
    `Replacement no longer matches: ${find}`,
  );
  candidateSource = candidateSource.replace(find, replace);
}

function compileCopyLoop(text) {
  const opening = 'let blockSamples = 0;';
  const closing =
    'wasmModule._seek(this.bufferLength, currentMapSegment.rate);';
  assert.equal(
    text.split(opening).length,
    2,
    'Buffered loop start is not unique',
  );
  assert.equal(
    text.split(closing).length,
    2,
    'Buffered loop end is not unique',
  );
  const start = text.indexOf(opening);
  const end = text.indexOf(closing, start);
  assert.ok(end > start, 'Buffered loop boundaries changed');
  return new Function(
    'buffers',
    'inputSamplesEnd',
    `${text.slice(start, end)}
return { blockSamples, inputSamples, audioSamples, audioBufferIndex };`,
  );
}

const baseline = compileCopyLoop(source);
const candidate = compileCopyLoop(candidateSource);
const started = performance.now();
const results = {
  seed: 0x71c8e24d,
  cases: 0,
  sampleComparisons: 0,
  paddingCursorOvershoots: 0,
  maximumPaddingOvershoot: 0,
};

function makeChunks(lengths, channelCounts, start = 0) {
  let position = start;
  return lengths.map((length, index) => {
    const channels = Array.from(
      { length: channelCounts[index % channelCounts.length] },
      (_, channel) =>
        Float32Array.from({ length }, (_, frame) =>
          Math.fround(
            ((((position + frame) * 37 + channel * 503 + 11) % 8191) - 4095) /
              8192,
          ),
        ),
    );
    position += length;
    return channels;
  });
}

function copyWith(loop, fixture) {
  const buffers = Array.from({ length: fixture.outputChannels }, () =>
    new Float32Array(fixture.length).fill(NaN),
  );
  const state = loop.call(
    {
      audioBuffers: fixture.chunks,
      audioBuffersStart: fixture.start,
      bufferLength: fixture.length,
    },
    buffers,
    fixture.end,
  );
  return { buffers, state };
}

function referenceCopy(fixture) {
  return Array.from({ length: fixture.outputChannels }, (_, channel) => {
    const output = new Float32Array(fixture.length);
    for (let frame = 0; frame < output.length; frame++) {
      let offset = fixture.end - fixture.length + frame - fixture.start;
      if (offset < 0) continue;
      for (const chunk of fixture.chunks) {
        if (offset < chunk[0].length) {
          output[frame] = chunk[channel % chunk.length][offset];
          break;
        }
        offset -= chunk[0].length;
      }
    }
    return output;
  });
}

function verify(fixture) {
  const expected = referenceCopy(fixture);
  const { buffers, state } = copyWith(candidate, fixture);
  for (let channel = 0; channel < buffers.length; channel++) {
    for (let frame = 0; frame < fixture.length; frame++) {
      const actual = buffers[channel][frame];
      if (!Object.is(actual, expected[channel][frame])) {
        assert.fail(
          `${fixture.name}: channel ${channel}, frame ${frame}, expected ${expected[channel][frame]}, received ${actual}`,
        );
      }
    }
  }
  assert.ok(
    state.audioBufferIndex <= fixture.chunks.length,
    `${fixture.name}: invalid chunk cursor`,
  );
  if (state.blockSamples > fixture.length) {
    results.paddingCursorOvershoots++;
    results.maximumPaddingOvershoot = Math.max(
      results.maximumPaddingOvershoot,
      state.blockSamples - fixture.length,
    );
  }
  results.cases++;
  results.sampleComparisons += fixture.length * buffers.length;
}

const failure = {
  name: 'Original four-chunk control failure',
  chunks: makeChunks([48000, 48000, 48000, 48000], [2]),
  start: 0,
  length: 5760,
  end: 72000,
  outputChannels: 2,
};

assert.throws(() => copyWith(baseline, failure), { name: 'RangeError' });
verify(failure);

const boundaries = [
  -4096, -1, 0, 1, 2, 3, 9, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 25, 27, 28,
  29, 31, 64, 4096,
];

for (const lengths of [[], [0], [28], [1, 0, 2, 7, 3, 0, 11, 4]]) {
  for (const start of [0, 137, 1000000000]) {
    for (const channels of [[1], [2], [1, 2]]) {
      const chunks = makeChunks(lengths, channels, start);
      for (const outputChannels of [1, 2]) {
        for (const length of [1, 7, 17, 64]) {
          for (const end of boundaries) {
            verify({
              name: `Boundary ${lengths.join(',')} start ${start} channels ${channels.join(',')} output ${outputChannels} window ${length} end ${end}`,
              chunks,
              start,
              length,
              end: start + end,
              outputChannels,
            });
          }
        }
      }
    }
  }
}

let seed = results.seed;

function randomBelow(limit) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % limit;
}

for (let index = 0; index < 400; index++) {
  const start = randomBelow(2000000);
  const lengths = Array.from({ length: randomBelow(10) }, () =>
    randomBelow(513),
  );
  const channels = lengths.map(() => 1 + randomBelow(2));
  const chunks = makeChunks(lengths, channels, start);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const length = [1, 7, 128, 576, 2048][randomBelow(5)];
  const outputChannels = 1 + randomBelow(2);
  const ends = [
    -1 - randomBelow(4096),
    0,
    1,
    total,
    total + 1,
    total + length + 32,
  ];
  let boundary = 0;
  for (const chunkLength of lengths) {
    boundary += chunkLength;
    ends.push(boundary - 1, boundary, boundary + 1);
  }
  for (let sample = 0; sample < 4; sample++) {
    ends.push(randomBelow(total + length * 2 + 1) - length);
  }
  for (const end of ends) {
    verify({
      name: `Seeded fixture ${index} end ${end}`,
      chunks,
      start,
      length,
      end: start + end,
      outputChannels,
    });
  }
}

results.baselineRangeErrorReproduced = true;
results.vendorSha256 = checksum;
results.elapsedMilliseconds = Math.round(performance.now() - started);
console.log(JSON.stringify(results, null, 2));
console.log(
  'Candidate PCM matches the per-sample reference. No vendor or production code was modified.',
);
if (results.paddingCursorOvershoots) {
  console.log(
    'Existing leading-padding cursor can exceed the window size; copied PCM remains correct in these cases.',
  );
}
