// Drives the background gradient canvas (body::before / body::after in
// style.css). The motion is a JS requestAnimationFrame loop — deliberately not
// CSS keyframes — because it has to ease smoothly down to a dead stop and then
// freeze *exactly* where it is. A CSS animation, paused or with its duration
// changed, snaps to a recomputed keyframe position; this never does.
//
//   - idle: frozen wherever it came to rest, so the wash never competes with a
//     reply you're reading
//   - the agent is generating: a brisk, clearly visible drift plus a slow
//     "breathing" swell on the second bloom layer — an unmistakable progress cue
//   - first launch, before there's anything on screen: a gentle welcome drift
//     that eases away on the first interaction
//
// Every frame advances one monotonic `phase` by `speed`, and `speed` itself
// eases toward its target (0 idle / low welcome / high active). Because `phase`
// only ever moves forward, the position is continuous at every moment —
// stopping is just `speed → 0`, which leaves the last transform in place.

const body = document.body;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Drift playback rate, in phase-units per second.
const SPEED_IDLE = 0;
const SPEED_WELCOME = 0.5;
const SPEED_ACTIVE = 2.6;
// Exponential-ease time constants (seconds). The ~0.55s speed constant is what
// turns "generation done" into a soft ~2.5s glide to rest instead of a halt.
const TAU_SPEED = 0.55;
const TAU_PULSE = 0.8;

const busy = new Set<string>();
let welcoming = false;

let speed = 0;
let pulse = 0; // 0 calm … 1 generating — drives amplitude + the breathing swell
let phase = 0;
let breath = 0;
let raf = 0;
let lastTs = 0;

function targetSpeed(): number {
  if (busy.size > 0) return SPEED_ACTIVE;
  if (welcoming) return SPEED_WELCOME;
  return SPEED_IDLE;
}

function frame(ts: number) {
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0;
  lastTs = ts;

  const tSpeed = targetSpeed();
  speed += (tSpeed - speed) * (1 - Math.exp(-dt / TAU_SPEED));
  pulse += ((busy.size > 0 ? 1 : 0) - pulse) * (1 - Math.exp(-dt / TAU_PULSE));

  phase += speed * dt;
  breath += (0.7 + speed * 0.25) * dt;

  const amp = 3.4 + pulse * 1.8;
  const p = phase;

  const x1 = Math.sin(p * 0.5) * amp + Math.sin(p * 0.23 + 1.3) * amp * 0.5;
  const y1 = Math.cos(p * 0.42) * amp * 0.8 + Math.sin(p * 0.29) * amp * 0.45;
  const r1 = Math.sin(p * 0.37) * 4;
  const x2 = Math.sin(p * 0.4 + 2.1) * amp + Math.cos(p * 0.19) * amp * 0.5;
  const y2 = Math.cos(p * 0.33 + 0.7) * amp * 0.8;
  const r2 = Math.sin(p * 0.28 + 1.1) * -4.5;

  const b = Math.sin(breath * 1.1);
  const s1 = 1.4 + pulse * 0.03 * b;
  const s2 = 1.46 + pulse * 0.035 * b;
  const o2 = Math.min(0.8 + pulse * (0.16 + 0.12 * b), 1);

  const st = body.style;
  st.setProperty("--atmo-x1", x1.toFixed(2) + "%");
  st.setProperty("--atmo-y1", y1.toFixed(2) + "%");
  st.setProperty("--atmo-r1", r1.toFixed(2) + "deg");
  st.setProperty("--atmo-s1", s1.toFixed(4));
  st.setProperty("--atmo-x2", x2.toFixed(2) + "%");
  st.setProperty("--atmo-y2", y2.toFixed(2) + "%");
  st.setProperty("--atmo-r2", r2.toFixed(2) + "deg");
  st.setProperty("--atmo-s2", s2.toFixed(4));
  st.setProperty("--atmo-o2", o2.toFixed(3));

  // Keep going while anything is still moving or easing down; otherwise let the
  // frozen transform stand.
  if (speed > 0.004 || pulse > 0.004 || tSpeed > 0) {
    raf = requestAnimationFrame(frame);
  } else {
    stopLoop();
  }
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  lastTs = 0;
  speed = 0;
}

function kick() {
  if (reduceMotion.matches) {
    stopLoop(); // leave the static CSS fallback composition in place
    return;
  }
  if (!raf && (targetSpeed() > 0 || speed > 0 || pulse > 0)) {
    lastTs = 0;
    raf = requestAnimationFrame(frame);
  }
}

/** Ref-counted per source key: an agent turn started (`on`) or finished. */
export function atmosphereBusy(key: string, on: boolean) {
  if (on) busy.add(key);
  else busy.delete(key);
  kick();
}

/** A gentle welcome drift until the first interaction, or 12s — whichever first. */
export function atmosphereWelcome() {
  if (welcoming) return;
  welcoming = true;
  kick();

  const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  const stop = () => {
    if (!welcoming) return;
    welcoming = false;
    clearTimeout(timer);
    for (const ev of events) window.removeEventListener(ev, stop);
    kick();
  };
  const timer = setTimeout(stop, 12_000);
  for (const ev of events) window.addEventListener(ev, stop, { passive: true });
}
