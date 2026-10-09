export function createStarMotion(
  paint: (x: number, y: number) => void,
  view?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
): (speed: number) => void;
