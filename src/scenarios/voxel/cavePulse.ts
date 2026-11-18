// Voxel Dreamscape: the pulse of the cave and Nether light blocks (pure, no Three.js, no DOM). As in the Synthwave
// mountains and sun, no beats are detected: every frame reads the current level of the band (bass or mids) and the light
// follows it. To stay dark by default the level is measured over its local floor (the mean over `floorS`, centred) and
// scaled by the local range (the max over `peakS` above that floor), so every hit rises to about 1, a held note sinks
// back to dark, and two hits in a row ("tum-tum") read as two flashes. The tracks are computed once per timeline
// (memoized) and each segment carries the slice around its time span. Pure function of the timeline.
import { SILENCE_LEVEL, type Timeline } from '../../audio/intelligence/timeline.ts';

export const LEVEL_PULSE = {
  /** Window (s, centred) of the local floor (mean) and of the local peak (max) of the band level. */
  floorS: 0.5,
  peakS: 1,
  /** Smallest range (peak - floor) the level is scaled by, so a near-flat passage stays dark instead of amplified. */
  minRange: 0.15,
  /** Track time (s) kept before and after each segment's time span. */
  marginS: 2,
} as const;

/** The pulse tracks around a span of track time, at the timeline rate: frame k is at time t0 + k / rate. */
export interface CavePulse {
  t0: number;
  rate: number;
  /** 0..1: bass pulse (Nether glowstone), mids pulse (cave wall lamps). */
  bass: Float32Array;
  mid: Float32Array;
}

interface Tracks { bass: Float32Array; mid: Float32Array }
const cache = new WeakMap<Timeline, Tracks>();

/** Level over its local floor, scaled by the local range, 0..1; 0 in silence. */
function pulseOf(level: Float32Array, energy: Float32Array, rate: number): Float32Array {
  const n = level.length, out = new Float32Array(n);
  const rf = Math.max(1, Math.round((LEVEL_PULSE.floorS * rate) / 2)), rp = Math.max(1, Math.round((LEVEL_PULSE.peakS * rate) / 2));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + level[i]!;
  // Sliding max over the centred peak window (monotonic deque of indices).
  const dq = new Int32Array(n);
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    for (; next < Math.min(n, i + rp + 1); next++) {
      while (tail > head && level[dq[tail - 1]!]! <= level[next]!) tail--;
      dq[tail++] = next;
    }
    while (dq[head]! < i - rp) head++;
    if (energy[i]! <= SILENCE_LEVEL) continue;
    const a = Math.max(0, i - rf), b = Math.min(n, i + rf + 1);
    const floor = (prefix[b]! - prefix[a]!) / (b - a);
    const range = Math.max(LEVEL_PULSE.minRange, level[dq[head]!]! - floor);
    out[i] = Math.min(1, Math.max(0, (level[i]! - floor) / range));
  }
  return out;
}

function tracksOf(timeline: Timeline): Tracks {
  const hit = cache.get(timeline);
  if (hit) return hit;
  const { rate, tracks } = timeline.data;
  const out = { bass: pulseOf(tracks.bass, tracks.energy, rate), mid: pulseOf(tracks.mid, tracks.energy, rate) };
  cache.set(timeline, out);
  return out;
}

/** The pulse tracks within [t0 - marginS, t1 + marginS]. */
export function cavePulse(timeline: Timeline, t0: number, t1: number): CavePulse {
  const { rate } = timeline.data;
  const all = tracksOf(timeline), n = all.bass.length;
  const a = Math.min(n, Math.max(0, Math.floor((t0 - LEVEL_PULSE.marginS) * rate)));
  const b = Math.min(n, Math.max(a, Math.ceil((t1 + LEVEL_PULSE.marginS) * rate) + 1));
  return { t0: a / rate, rate, bass: all.bass.slice(a, b), mid: all.mid.slice(a, b) };
}

/** Pulse values at track time t (linear between frames like Timeline.evaluate). */
export function pulseAt(p: CavePulse, t: number, out = { bass: 0, mid: 0 }): { bass: number; mid: number } {
  const x = (t - p.t0) * p.rate, n = p.bass.length;
  if (n === 0 || x < 0 || x > n - 1) { out.bass = 0; out.mid = 0; return out; }
  const i = Math.max(0, Math.min(n - 2, Math.floor(x))), f = n > 1 ? x - i : 0, j = Math.min(n - 1, i + 1);
  out.bass = p.bass[i]! + (p.bass[j]! - p.bass[i]!) * f;
  out.mid = p.mid[i]! + (p.mid[j]! - p.mid[i]!) * f;
  return out;
}
