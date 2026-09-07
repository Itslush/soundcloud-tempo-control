document.querySelectorAll<HTMLElement>('[data-select]').forEach((root) => {
  const select = root.querySelector('select')!;
  const trigger = root.querySelector<HTMLButtonElement>('.select-trigger')!;
  const list = root.querySelector<HTMLElement>('[role="listbox"]')!;
  const options = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ];
  let search = '';
  let searchTime = 0;
  select.hidden = true;
  trigger.hidden = false;

  function close(restore = false) {
    list.inert = true;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus();
  }

  function open() {
    list.inert = false;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    options[Math.max(0, select.selectedIndex)].focus();
  }

  function sync() {
    trigger.querySelector('.select-value')!.textContent =
      select.selectedOptions[0].textContent;
    options.forEach((option) =>
      option.setAttribute(
        'aria-selected',
        String(option.dataset.value === select.value),
      ),
    );
  }

  trigger.addEventListener('click', () => (list.hidden ? open() : close()));
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (list.hidden) {
        open();
        return;
      }
      const index = options.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
              options.length;
      options[next].focus();
      return;
    }
    if (
      event.key.length !== 1 ||
      event.key === ' ' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const now = Date.now();
    search = (now - searchTime < 700 ? search : '') + event.key.toLowerCase();
    searchTime = now;
    const match = options.find((option) =>
      option.textContent!.trim().toLowerCase().startsWith(search),
    );
    if (match) {
      event.preventDefault();
      if (list.hidden) open();
      match.focus();
    }
  });
  options.forEach((option) =>
    option.addEventListener('click', () => {
      select.value = option.dataset.value!;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      close(true);
    }),
  );
  select.addEventListener('change', sync);
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target as Node)) close();
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget as Node)) close();
  });
});
