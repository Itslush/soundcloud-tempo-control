export function initNumberFields() {
  const fields = Array.from(
    document.querySelectorAll<HTMLElement>('[data-number-field]'),
    (element) => {
      const input = element.querySelector('input')!;
      const buttons = Array.from(
        element.querySelectorAll<HTMLButtonElement>('[data-step]'),
      );
      let previous = input.valueAsNumber;
      const bound = (value: string, fallback: number) =>
        value === '' ? fallback : Number(value);
      const clamp = (value: number) =>
        Math.min(
          bound(input.max, Infinity),
          Math.max(bound(input.min, -Infinity), value),
        );

      function sync() {
        const value = input.valueAsNumber;
        element.style.setProperty(
          '--number-digits',
          String(Math.max(3, input.value.length)),
        );
        if (Number.isFinite(value)) previous = value;
        const disabled = input.disabled || input.readOnly;
        element.toggleAttribute('data-disabled', disabled);
        for (const button of buttons) {
          const limit =
            Number(button.dataset.step) < 0
              ? value <= bound(input.min, -Infinity)
              : value >= bound(input.max, Infinity);
          button.disabled = disabled || !Number.isFinite(value) || limit;
        }
      }

      function commit() {
        const value = input.valueAsNumber;
        input.value = String(clamp(Number.isFinite(value) ? value : previous));
        sync();
      }

      function step(direction: number) {
        if (input.disabled || input.readOnly) return;
        const value = Number.isFinite(input.valueAsNumber)
          ? input.valueAsNumber
          : previous;
        const amount = Number(input.step) || 1;
        const precision = Math.max(3, Math.min(6, Math.ceil(-Math.log10(amount))));
        input.value = String(
          clamp(Number((value + direction * amount).toFixed(precision))),
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      }

      for (const button of buttons)
        button.addEventListener('click', () =>
          step(Number(button.dataset.step)),
        );
      input.addEventListener('change', commit, { capture: true });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          step(event.key === 'ArrowUp' ? 1 : -1);
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      sync();
      return sync;
    },
  );
  return () => fields.forEach((sync) => sync());
}
