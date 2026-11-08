const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = 800;
const STEP_DISTANCE_PX = 40;
const STEP_COOLDOWN_MS = 200;
const GESTURE_IDLE_MS = 150;

/** Turns wheel events into single steps. A mouse notch moves once; a trackpad swipe needs distance. */
export function createWheelStepper() {
  let distance = 0;
  let lastEventAt = Number.NEGATIVE_INFINITY;
  let lockedUntil = Number.NEGATIVE_INFINITY;
  return function step(event: { deltaY: number; deltaMode: number; timeStamp: number }) {
    if (event.timeStamp - lastEventAt > GESTURE_IDLE_MS) distance = 0;
    lastEventAt = event.timeStamp;
    if (event.timeStamp < lockedUntil) return 0;
    const unit = [1, WHEEL_LINE_PX, WHEEL_PAGE_PX][event.deltaMode] ?? 1;
    distance += event.deltaY * unit;
    if (Math.abs(distance) < STEP_DISTANCE_PX) return 0;
    const direction = Math.sign(distance);
    distance = 0;
    lockedUntil = event.timeStamp + STEP_COOLDOWN_MS;
    return direction;
  };
}
