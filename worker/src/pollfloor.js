// A floor under how often one device may make us look at the queue.
//
// Its own module because it is testable and worth testing: it is the thing
// standing between a client bug and another day of D1 returning errors.

/**
 * The floor under how often one device may make us look at the queue.
 *
 * A device that is told "nothing for you" and comes straight back is a hot
 * loop against D1, and the agent has exactly that shape: on an empty answer
 * `cycle()` returns 0 and polls again. It is safe today only because the long
 * poll consumes twenty-five seconds first - so every empty answer that returns
 * QUICKLY is a spin waiting for a reason to happen. Being refused a job the
 * moment the kill switch goes on would do it, and so would a bug in the wait.
 *
 * The fix is on this side because the client cannot be trusted to have it: the
 * Pico's firmware is frozen, the agent runs whatever version is on the Pi, and
 * "we shipped a fix" is not a property the database can rely on. A device that
 * comes back too soon is simply made to wait out the difference before
 * anything is read. It gets the answer it asked for, one second later, and the
 * loop settles at 1 Hz whatever the client believes.
 *
 * Per-isolate, and that is enough: a spin hits one colo, and an isolate that
 * has never seen the device lets the first poll straight through.
 */
export const EMPTY_FLOOR_MS = 1000;
// One entry per device, and a ceiling so a torrent of invented device names
// cannot grow this without bound. Sixty-four is far more machines than this
// will ever have; past that the oldest entry goes, which at worst lets one
// device through the floor once.
const EMPTY_FLOOR_MAX = 64;
const lastEmptyAt = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits out whatever is left of this device's floor, and says how long it was.
 *
 * `now` and `sleeper` are injectable so the tests can assert the delay without
 * spending it - a suite that actually waits a second per case is a suite
 * people stop running.
 */
export async function respectEmptyFloor(deviceId, now = Date.now(), sleeper = sleep) {
  const previous = lastEmptyAt.get(deviceId);
  const gap = previous === undefined ? Infinity : now - previous;
  if (gap >= EMPTY_FLOOR_MS) return 0;
  const owed = EMPTY_FLOOR_MS - gap;
  await sleeper(owed);
  return owed;
}

/** Remembers that this device was just turned away empty-handed. */
export function markEmpty(deviceId, now = Date.now()) {
  if (lastEmptyAt.size >= EMPTY_FLOOR_MAX && !lastEmptyAt.has(deviceId)) {
    lastEmptyAt.delete(lastEmptyAt.keys().next().value);
  }
  lastEmptyAt.set(deviceId, now);
}

/** How many devices are being remembered. The ceiling, observable. */
export const trackedDevices = () => lastEmptyAt.size;

/** Forgets every device. For tests, which must not inherit each other's clock. */
export function resetPollFloor() {
  lastEmptyAt.clear();
}
