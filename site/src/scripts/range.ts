export function syncRange(input: HTMLInputElement) {
  const minimum = Number(input.min) || 0;
  const span = Number(input.max) - minimum;
  const value = span > 0 ? (input.valueAsNumber - minimum) / span : 0;
  const fill = `${Math.max(0, Math.min(1, value || 0)) * 100}%`;
  if (input.style.getPropertyValue('--range-fill') !== fill)
    input.style.setProperty('--range-fill', fill);
}
