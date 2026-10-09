export function validOutputDb(value) {
  return (
    Number.isFinite(value) &&
    value >= -24 &&
    Number.isFinite(Math.fround(10 ** (value / 20)))
  );
}
