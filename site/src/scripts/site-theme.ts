export {};

const key = 'soundcloud.tempo.siteTheme';
const buttons =
  document.querySelectorAll<HTMLButtonElement>('[data-site-theme]');
const status = document.querySelector('#site-theme-status');

function applyTheme(value: string | null | undefined) {
  const theme = value === 'light' || value === 'oled' ? value : 'charcoal';
  document.documentElement.dataset.theme = theme;
  for (const button of buttons)
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.siteTheme === theme),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      getComputedStyle(document.documentElement)
        .getPropertyValue('--ground')
        .trim(),
    );
  return theme;
}

applyTheme(document.documentElement.dataset.theme);
for (const button of buttons) {
  button.addEventListener('click', () => {
    const theme = applyTheme(button.dataset.siteTheme);
    try {
      localStorage.setItem(key, theme);
      if (status) status.textContent = '';
    } catch {
      if (status)
        status.textContent =
          'Changed for this visit. Your browser could not save the theme.';
    }
  });
}
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null)
    applyTheme(event.key === null ? null : event.newValue);
});
