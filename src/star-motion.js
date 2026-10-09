export function createStarMotion(paint, view = window) {
  let frame = 0;
  let previous = null;
  let speed = 0;
  let x = 0;
  let y = 0;
  let elapsed = 0;
  let period = 6 + Math.random() * 10;
  let heading = Math.random() * Math.PI * 2;
  let turn = (Math.random() - 0.5) * Math.PI * 1.6;

  function animate(time) {
    const dt = previous === null ? 0 : Math.min((time - previous) / 1000, 0.05);
    previous = time;
    elapsed += dt * speed;
    if (elapsed >= period) {
      heading = (heading + turn) % (Math.PI * 2);
      elapsed -= period;
      period = 6 + Math.random() * 10;
      turn = (Math.random() - 0.5) * Math.PI * 1.6;
    }
    const t = elapsed / period;
    const angle = heading + turn * t * t * (3 - 2 * t);
    // Whole-tile wrapping keeps long visits from exposing an edge.
    x = (x + Math.cos(angle) * (100 / 15) * speed * dt) % 960;
    y = (y + Math.sin(angle) * (100 / 15) * speed * dt) % 840;
    paint(x, y);
    frame = view.requestAnimationFrame(animate);
  }

  return function setSpeed(next) {
    view.cancelAnimationFrame(frame);
    frame = 0;
    previous = null;
    speed = next;
    if (speed > 0) frame = view.requestAnimationFrame(animate);
  };
}
