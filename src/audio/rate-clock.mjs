const QUANTUM = 128;
const MIN_RATE = 0.025;
const MAX_SOURCE_SECONDS = 24 * 60 * 60;
const MAX_OUTPUT_SECONDS = MAX_SOURCE_SECONDS / MIN_RATE;

function sampleRate(value) {
  if (!Number.isInteger(value) || value < 8000 || value > 384000)
    throw new RangeError('Unsupported sample rate');
  return value;
}

function intervalAt(intervals, value, key) {
  let left = 0;
  let right = intervals.length - 1;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (intervals[middle][key] <= value) left = middle;
    else right = middle - 1;
  }
  return intervals[left];
}

export function createRateWindow({
  outputStartFrame,
  sourceStartFrame,
  sourceSampleRate,
  outputSampleRate,
  frameCount,
  rateAt,
}) {
  const sourceRate = sampleRate(sourceSampleRate);
  const outputRate = sampleRate(outputSampleRate);
  const sourceLimit = sourceRate * MAX_SOURCE_SECONDS;
  if (
    !Number.isSafeInteger(outputStartFrame) ||
    outputStartFrame < 0 ||
    outputStartFrame % QUANTUM
  )
    throw new RangeError('Start must be aligned to a render quantum');
  if (!Number.isFinite(sourceStartFrame) || sourceStartFrame < 0)
    throw new RangeError('Invalid source position');
  if (sourceStartFrame > sourceLimit)
    throw new RangeError('Source position exceeds the 24-hour clock limit');
  if (
    !Number.isInteger(frameCount) ||
    frameCount <= 0 ||
    frameCount > outputRate * 2 ||
    frameCount % QUANTUM
  )
    throw new RangeError(
      'Window must contain at most two seconds of whole render quanta',
    );
  if (typeof rateAt !== 'function')
    throw new TypeError('A rate function is required');
  const outputEndFrame = outputStartFrame + frameCount;
  if (
    !Number.isSafeInteger(outputEndFrame) ||
    outputEndFrame > outputRate * MAX_OUTPUT_SECONDS
  )
    throw new RangeError('Output position exceeds the 40-day clock limit');
  const intervals = [];
  let sourceFrame = sourceStartFrame;
  for (
    let outputFrame = outputStartFrame;
    outputFrame < outputEndFrame;
    outputFrame += QUANTUM
  ) {
    const requestedRate = rateAt(sourceFrame / sourceRate);
    if (
      !Number.isFinite(requestedRate) ||
      requestedRate < MIN_RATE ||
      requestedRate > 4
    )
      throw new RangeError('Playback rate must be between 0.025 and 4');
    const rate = Math.fround(requestedRate);
    const sourceFramesPerOutputFrame = (rate * sourceRate) / outputRate;
    const nextSourceFrame = sourceFrame + QUANTUM * sourceFramesPerOutputFrame;
    if (!Number.isFinite(nextSourceFrame) || nextSourceFrame <= sourceFrame)
      throw new RangeError('Source interval must advance');
    if (nextSourceFrame > sourceLimit)
      throw new RangeError('Source position exceeds the 24-hour clock limit');
    intervals.push(
      Object.freeze({
        outputFrame,
        sourceFrame,
        rate,
        sourceFramesPerOutputFrame,
      }),
    );
    sourceFrame = nextSourceFrame;
  }
  const sourceEndFrame = sourceFrame;
  const sourceAt = (outputFrame) => {
    if (
      !Number.isFinite(outputFrame) ||
      outputFrame < outputStartFrame ||
      outputFrame > outputEndFrame
    )
      throw new RangeError('Output position is outside the scheduled window');
    if (outputFrame === outputEndFrame) return sourceEndFrame;
    const interval = intervalAt(intervals, outputFrame, 'outputFrame');
    return (
      interval.sourceFrame +
      (outputFrame - interval.outputFrame) * interval.sourceFramesPerOutputFrame
    );
  };
  const outputAt = (frame) => {
    if (
      !Number.isFinite(frame) ||
      frame < sourceStartFrame ||
      frame > sourceEndFrame
    )
      throw new RangeError('Source position is outside the scheduled window');
    if (frame === sourceEndFrame) return outputEndFrame;
    const interval = intervalAt(intervals, frame, 'sourceFrame');
    return (
      interval.outputFrame +
      (frame - interval.sourceFrame) / interval.sourceFramesPerOutputFrame
    );
  };
  return Object.freeze({
    sourceSampleRate: sourceRate,
    outputSampleRate: outputRate,
    outputStartFrame,
    outputEndFrame,
    sourceStartFrame,
    sourceEndFrame,
    intervals: Object.freeze(intervals),
    sourceAt,
    outputAt,
  });
}
