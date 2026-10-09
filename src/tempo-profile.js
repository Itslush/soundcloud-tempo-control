export const round = (value) => Math.round(value * 1000) / 1000;
export const validKeyShift = (value) =>
  Number.isFinite(value) && Math.abs(value) <= 12;
const curves = ['instant', 'linear', 'ease-in', 'ease-out', 'smooth'];

function validatePoints(points, duration, field) {
  if (!Array.isArray(points) || !points.length || points.length > 200)
    throw new Error('Use between 1 and 200 points per lane.');
  const result = points.map((point, index) => {
    const previous = points[index - 1];
    if (
      !point ||
      ![point.t, point[field], point.d].every(Number.isFinite) ||
      point.t < 0 ||
      point.t > duration ||
      point.d < 0 ||
      !curves.includes(point.c) ||
      (field === 'r'
        ? point.r < 0.025 || point.r > 4
        : !validKeyShift(point.k)) ||
      (!index && (point.t !== 0 || point.d !== 0)) ||
      (index && (point.t <= previous.t || point.t - point.d < previous.t))
    )
      throw new Error(
        'Invalid points: check values, times, and overlapping fades.',
      );
    return {
      t: round(point.t),
      [field]: round(field === 'r' ? Math.max(0.25, point.r) : point.k),
      d: round(point.d),
      c: point.c,
    };
  });
  for (let index = 1; index < result.length; index++)
    if (
      result[index].t <= result[index - 1].t ||
      round(result[index].t - result[index].d) < result[index - 1].t
    )
      throw new Error('Points are too close together.');
  return result;
}

export function validateProfile(value, parseTrack) {
  if (
    !value ||
    value.v !== 1 ||
    typeof value.track !== 'string' ||
    parseTrack(value.track) !== value.track ||
    !Number.isFinite(value.duration) ||
    value.duration < 1 ||
    value.duration > 86400
  )
    throw new Error('Invalid tempo code or unsupported version.');
  if (
    value.pitch !== undefined &&
    !['natural', 'preserve'].includes(value.pitch)
  )
    throw new Error('Invalid pitch mode.');
  if (value.keyShift !== undefined && !validKeyShift(value.keyShift))
    throw new Error('Key shift must be between -12 and 12 semitones.');
  return {
    v: 1,
    track: value.track,
    duration: value.duration,
    points: validatePoints(value.points, value.duration, 'r'),
    ...(value.pitch === undefined ? {} : { pitch: value.pitch }),
    ...(value.keyShift === undefined ? {} : { keyShift: value.keyShift }),
    ...(value.pitchPoints === undefined
      ? {}
      : {
          pitchPoints: validatePoints(value.pitchPoints, value.duration, 'k'),
        }),
  };
}

export function evaluatePoints(points, time, field = 'r') {
  let previous = points[0];
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    if (time < point.t) {
      if (!point.d || point.c === 'instant' || time <= point.t - point.d)
        return previous[field];
      let x = Math.max(0, Math.min(1, (time - point.t + point.d) / point.d));
      if (point.c === 'ease-in') x *= x;
      else if (point.c === 'ease-out') x = 1 - (1 - x) ** 2;
      else if (point.c === 'smooth') x = x * x * (3 - 2 * x);
      return previous[field] + (point[field] - previous[field]) * x;
    }
    previous = point;
  }
  return previous[field];
}

export const profilePitchAt = (data, time) =>
  data.pitchPoints
    ? evaluatePoints(data.pitchPoints, time, 'k')
    : (data.keyShift ?? null);
