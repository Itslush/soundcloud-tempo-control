import { createStarMotion } from '../../../src/star-motion.js';

const field = document.querySelector('.space-accent');
const pattern = field?.querySelector('pattern');
const toggle = document.querySelector<HTMLButtonElement>('#site-star-motion');
const status = document.querySelector('#site-star-status');

if (field && pattern) {
  const forced = matchMedia('(forced-colors: active)');
  const key = 'soundcloud.tempo.siteStarMotion';
  let choice: string | null = null;
  try {
    choice = localStorage.getItem(key);
  } catch {}
  let visible = false;
  const drift = createStarMotion((x, y) => {
    pattern.setAttribute('patternTransform', `translate(${x} ${y})`);
  });
  toggle?.closest('details')?.removeAttribute('hidden');

  function sync() {
    const enabled = choice !== 'off';
    const active = visible && !document.hidden && enabled && !forced.matches;
    field!.toggleAttribute('data-visible', active);
    toggle?.setAttribute('aria-pressed', String(enabled));
    if (toggle) toggle.textContent = `Star motion: ${enabled ? 'On' : 'Off'}`;
    drift(active ? 1.5 : 0);
  }

  toggle?.addEventListener('click', () => {
    choice = toggle.getAttribute('aria-pressed') === 'true' ? 'off' : 'on';
    sync();
    try {
      localStorage.setItem(key, choice);
      if (status) status.textContent = '';
    } catch {
      if (status)
        status.textContent =
          'Changed for this visit. Your browser could not save the setting.';
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    choice = event.key === null ? null : event.newValue;
    sync();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(field);
  document.addEventListener('visibilitychange', sync);
  forced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => drift(0));
  window.addEventListener('pageshow', sync);
}
