const field = document.querySelector('.space-accent');
const pattern = field?.querySelector('pattern');

if (field && pattern) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const forced = matchMedia('(forced-colors: active)');
  const speed = 1.5;
  let visible = false;
  let frame = 0;
  let previous: number | null = null;
  let x = 0;
  let y = 0;
  let elapsed = 0;
  let period = (6 + Math.random() * 10) / speed;
  let heading = Math.random() * Math.PI * 2;
  let turn = (Math.random() - 0.5) * Math.PI * 1.6;

  function animate(time: number) {
    const dt = previous === null ? 0 : Math.min((time - previous) / 1000, 0.05);
    previous = time;
    elapsed += dt;
    if (elapsed >= period) {
      heading = (heading + turn) % (Math.PI * 2);
      elapsed -= period;
      period = (6 + Math.random() * 10) / speed;
      turn = (Math.random() - 0.5) * Math.PI * 1.6;
    }
    const t = elapsed / period;
    const angle = heading + turn * t * t * (3 - 2 * t);
    // Wrap by whole tiles so long visits never expose an edge or reset the stars.
    x = (x + Math.cos(angle) * (100 / 15) * speed * dt) % 960;
    y = (y + Math.sin(angle) * (100 / 15) * speed * dt) % 840;
    pattern!.setAttribute('patternTransform', `translate(${x} ${y})`);
    frame = requestAnimationFrame(animate);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = null;
    const active =
      visible && !document.hidden && !reduced.matches && !forced.matches;
    field!.toggleAttribute('data-visible', active);
    if (active) frame = requestAnimationFrame(animate);
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(field);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
  forced.addEventListener('change', sync);
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame);
    previous = null;
  });
  window.addEventListener('pageshow', sync);
}
