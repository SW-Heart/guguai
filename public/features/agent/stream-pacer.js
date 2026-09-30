// Paces a streamed reply so text appears at a steady reading speed.
//
// Reply text reaches the page in bursts (one chunk per status refresh), so
// revealing each burst as fast as possible produces a "rush, then stall"
// rhythm. The pacer instead follows the measured arrival speed and keeps a
// small reserve of unrevealed text, so characters keep flowing between bursts
// and speed changes are eased rather than abrupt. Speeds are chars per ms.
const MIN_RATE = 0.02;          // ~20 chars/s: slowest pace while text is waiting
const MAX_RATE = 2.5;           // upper bound when a large backlog must be cleared
const DEFAULT_INPUT_RATE = 0.04; // ~40 chars/s until real arrivals are measured
const DEFAULT_INTERVAL = 600;   // expected time between bursts before measuring
const CATCH_UP_MS = 900;        // how quickly the reserve is corrected
const FINISH_MS = 400;          // how quickly the tail is revealed once the reply ends
const FINISH_MIN_RATE = 0.12;   // ~120 chars/s floor so the last words do not trickle
const EASE_MS = 180;            // time constant for easing speed changes

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createStreamPacer({ now = () => performance.now() } = {}) {
  let target = '', chars = [], shown = 0, visible = '';
  let rate = 0, carry = 0, inputRate = DEFAULT_INPUT_RATE, interval = DEFAULT_INTERVAL, lastArrival = 0, done = false;

  function reset() {
    target = ''; chars = []; shown = 0; visible = '';
    rate = 0; carry = 0; lastArrival = 0; done = false;
    inputRate = DEFAULT_INPUT_RATE; interval = DEFAULT_INTERVAL;
  }

  function reveal() { shown = chars.length; visible = target; carry = 0; }

  // Sets the latest known reply text. `done` marks that no more text will
  // arrive, so the remaining tail is revealed promptly instead of reserved.
  function update(text, { done: finished = false, immediate = false } = {}) {
    const next = String(text ?? '');
    if (!next) { reset(); return; }
    if (!next.startsWith(visible)) reset();
    done = finished;
    if (next !== target) {
      const nextChars = next.startsWith(target) ? chars.concat(Array.from(next.slice(target.length))) : Array.from(next);
      const added = nextChars.length - chars.length;
      const time = now();
      if (added > 0 && !finished) {
        if (lastArrival) {
          const gap = clamp(time - lastArrival, 120, 2000);
          interval += (gap - interval) * 0.3;
          inputRate += (clamp(added / gap, MIN_RATE, MAX_RATE) - inputRate) * 0.35;
        } else {
          inputRate = clamp(added / interval, MIN_RATE, 0.15);
        }
        lastArrival = time;
      }
      target = next; chars = nextChars;
      if (shown > chars.length) { shown = chars.length; visible = target; }
    }
    if (immediate) reveal();
  }

  // Advances the visible text by `elapsed` ms. Returns true when it changed.
  function advance(elapsed) {
    const backlog = chars.length - shown;
    if (backlog <= 0) return false;
    const dt = clamp(Number(elapsed) || 0, 0, 64);
    const reserve = done ? 0 : inputRate * interval;
    let desired = inputRate + (backlog - reserve) / CATCH_UP_MS;
    if (done) desired = Math.max(desired, backlog / FINISH_MS, FINISH_MIN_RATE);
    desired = clamp(desired, MIN_RATE, MAX_RATE);
    rate += (desired - rate) * (1 - Math.exp(-dt / EASE_MS));
    rate = Math.max(rate, MIN_RATE);
    carry += rate * dt;
    const count = Math.min(backlog, Math.floor(carry));
    if (!count) return false;
    carry -= count;
    visible += chars.slice(shown, shown + count).join('');
    shown += count;
    if (shown === chars.length) carry = 0;
    return true;
  }

  return {
    update, advance, reveal, reset,
    get text() { return visible; },
    get target() { return target; },
    get caughtUp() { return shown >= chars.length; },
  };
}
