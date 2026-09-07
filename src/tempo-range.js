export function syncTempoRange(input) {
  const minimum = Number(input.min) || 0;
  const span = Number(input.max) - minimum;
  const value = span > 0 ? (input.valueAsNumber - minimum) / span : 0;
  const fill = `${Math.max(0, Math.min(1, value || 0)) * 100}%`;
  if (input.style.getPropertyValue('--range-fill') !== fill)
    input.style.setProperty('--range-fill', fill);
}

export const tempoRangeStyle = `
  input[type='range'] {
    --range-thumb-opacity: 1;
    appearance: none;
    -webkit-appearance: none;
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 32px;
    margin: 0;
    padding: 0;
    border: 0;
    background: linear-gradient(to right,
      var(--tempo-accent) var(--range-fill, 0%),
      var(--tempo-track) var(--range-fill, 0%))
      center / calc(100% - 12px) 2px no-repeat;
    cursor: pointer;
    touch-action: none;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 2px;
    background: transparent;
  }
  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    margin-top: -5px;
    border: 1px solid var(--tempo-accent);
    border-radius: 50%;
    background: var(--tempo-surface);
    opacity: var(--range-thumb-opacity);
    transition: opacity 120ms ease-out;
  }
  input[type='range']::-moz-range-track,
  input[type='range']::-moz-range-progress {
    height: 2px;
    background: transparent;
  }
  input[type='range']::-moz-range-thumb {
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    border: 1px solid var(--tempo-accent);
    border-radius: 50%;
    background: var(--tempo-surface);
    opacity: var(--range-thumb-opacity);
    transition: opacity 120ms ease-out;
  }
  input[type='range']:disabled {
    opacity: .45;
    cursor: default;
  }
  @media (hover: hover) and (pointer: fine) {
    input[type='range']:not(:hover):not(:focus-visible):not(:active) {
      --range-thumb-opacity: 0;
    }
  }
  @media (any-pointer: coarse), (forced-colors: active) {
    input[type='range'] {
      --range-thumb-opacity: 1 !important;
    }
  }
  @media (forced-colors: active) {
    input[type='range'] {
      forced-color-adjust: none;
      --tempo-accent: Highlight;
      --tempo-track: GrayText;
      --tempo-surface: Canvas;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    input[type='range']::-webkit-slider-thumb { transition: none; }
    input[type='range']::-moz-range-thumb { transition: none; }
  }
`;
