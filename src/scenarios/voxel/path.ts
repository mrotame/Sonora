// Voxel Dreamscape: music-driven camera pace (pure, no Three.js, no DOM).
// The camera follows a straight road at a fixed height (it only rises over bridges); its speed and field of view follow the music:
//   - Intensity (log loudness + spectral flux), smoothed over about 1.5 s with a centered (zero-lag) filter and
//     scaled between the song's 2nd and 98th percentile.
//   - Speed is set in log space around a cruise speed by how intense the moment is against the song's median, and
//     follows that target with a short time constant so it never jumps.
//   - The field of view widens with the speed (sense of velocity).
//   - After the music ends the speed eases down to `endKmh` for the controller's epilogue (PRODUCT_SPEC 2.4).
// The same intensity, smoothed over a longer window, is the baked driver of the floating archipelagos
// (`islandIntensityAt`). Everything is a pure function of the timeline, evaluated by track time.
// Same speed scale as Synthwave Dimension (cruise 280 km/h, 100..600 km/h), as requested by the user.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import type { Seed } from '../../world/identity/seed.ts';
import type { TrackPath } from '../types.ts';
import { bridgeOffsetAt, bridgeSlopeAt } from './road.ts';
import { scheduleOf } from './schedule.ts';
import { saltsFor } from './terrain.ts';

export const PACE = {
  /** Speed range and cruise speed in km/h (1 world unit = 1 m). */
  minKmh: 100,
  maxKmh: 600,
  cruiseKmh: 280,
  /** ln(speed) gained from the song's median (0) to its most intense moment; the same amount is lost toward its calmest. */
  intensityGain: 1.3,
  /** Time constant (s) of the speed following its target. */
  followTauS: 1.2,
  /** Half-width (s) of each of two centered box passes for the moment-to-moment intensity (about 1.5 s). */
  detailS: 0.75,
  /** Half-width (s) of each of two centered box passes for the archipelago driver (about 6 s). */
  islandS: 3,
  /** Half-width (s) of each of two centered box passes for the horizon mood (about 20 s). */
  moodS: 10,
  /** Intensity proxy: log loudness (energy in dB over `loudnessFloorDb`) and spectral flux. */
  loudnessWeight: 0.5,
  fluxWeight: 0.5,
  loudnessFloorDb: -30,
  /** Speed once the music has ended (trailing silence and epilogue), reached over `endSlowS` seconds. */
  endKmh: 50,
  endSlowS: 2.5,
  /** Vertical field of view (degrees) at the minimum and maximum speed, interpolated in log speed. */
  fovDeg: [60, 84],
} as const;

const KMH_TO_UNITS_PER_S = 1 / 3.6;

/**
 * Nether leg (Synthwave-like descent, implemented here so scenarios stay independent): the minecart drops along the
 * rails, steeper and faster the more intense the music is; a calm moment levels out or even climbs a little.
 */
export const NETHER_PATH = {
  /** Road slope (rise over run) at the calmest and at the most intense moment (negative = descending). */
  calmSlope: 0.06,
  steepSlope: -0.55,
  /** Intensity range mapped to the slope. */
  steepFrom: 0.15,
  steepTo: 0.85,
  /** Time constant (s) of the slope following its target, and the ramp-in after the entry portal. */
  followTauS: 0.7,
  rampInS: 1.5,
  /** ln(speed) gained at the steepest descent. */
  speedGain: 0.5,
} as const;

/** Running mean over [i - r, i + r], clamped at the ends (prefix sums, O(n)). Centered, so it adds no lag. */
function boxBlur(src: Float64Array, r: number): Float64Array {
  const n = src.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + src[i]!;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
    out[i] = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
  }
  return out;
}

const blur2 = (src: Float64Array, seconds: number, rate: number) => {
  const r = Math.max(1, Math.round(seconds * rate));
  return boxBlur(boxBlur(src, r), r);
};

function quantile(values: Float64Array, q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/** Linear interpolation of a uniformly sampled table; positions outside clamp to its ends. */
function sample(table: Float64Array, pos: number): number {
  const last = table.length - 1;
  if (last < 0) return 0;
  const p = Math.min(Math.max(pos, 0), last);
  const i = Math.floor(p);
  const j = Math.min(i + 1, last);
  return table[i]! + (table[j]! - table[i]!) * (p - i);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** Scales a curve between its 2nd and 98th percentile to 0..1 (flat curve: 0.5 everywhere). */
function normalize(curve: Float64Array): Float64Array {
  if (curve.length < 2) return curve.fill(0.5);
  const lo = quantile(curve, 0.02), hi = quantile(curve, 0.98);
  if (hi - lo < 1e-9) return curve.fill(0.5);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.min(1, Math.max(0, (curve[i]! - lo) / (hi - lo)));
  return curve;
}

interface IntensityCurves {
  /** Moment-to-moment intensity (pace). */
  detail: Float64Array;
  /** Slower intensity (archipelagos). */
  islands: Float64Array;
  /** Slowest intensity (horizon mood). */
  mood: Float64Array;
}

// Memoized per timeline object: a pure function of the immutable timeline, so caching cannot change any result.
const cache = new WeakMap<Timeline, IntensityCurves>();

export function intensityCurves(timeline: Timeline): IntensityCurves {
  const hit = cache.get(timeline);
  if (hit) return hit;
  const { rate, tracks } = timeline.data;
  const n = tracks.energy.length;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const db = 20 * Math.log10(Math.max(tracks.energy[i]!, 1e-6)); // energy is already scaled by the song's own peak
    const loud = Math.min(1, Math.max(0, 1 - db / PACE.loudnessFloorDb));
    raw[i] = PACE.loudnessWeight * loud + PACE.fluxWeight * tracks.flux[i]!;
  }
  const curves = {
    detail: normalize(blur2(raw, PACE.detailS, rate)),
    islands: normalize(blur2(raw, PACE.islandS, rate)),
    mood: normalize(blur2(raw, PACE.moodS, rate)),
  };
  cache.set(timeline, curves);
  return curves;
}

/** Slow intensity (0 calmest .. 1 most intense) at track time t: the baked driver of the archipelagos. */
export function islandIntensityAt(timeline: Timeline, t: number): number {
  return sample(intensityCurves(timeline).islands, t * timeline.data.rate);
}

/** Slowest intensity (0..1, about 20 s) at track time t: the horizon's mood. */
export function moodAt(timeline: Timeline, t: number): number {
  return sample(intensityCurves(timeline).mood, t * timeline.data.rate);
}

/** Field of view (degrees) for a speed in world units per second. */
export function fovForSpeed(v: number): number {
  const lo = Math.log(PACE.minKmh * KMH_TO_UNITS_PER_S), hi = Math.log(PACE.maxKmh * KMH_TO_UNITS_PER_S);
  const u = Math.min(1, Math.max(0, (Math.log(Math.max(v, 1e-6)) - lo) / (hi - lo)));
  return PACE.fovDeg[0] + (PACE.fovDeg[1] - PACE.fovDeg[0]) * u;
}

export function createVoxelPath(timeline: Timeline, worldSeed?: Seed): TrackPath {
  const salts = worldSeed ? saltsFor(worldSeed) : null;
  const { rate } = timeline.data;
  const intensity = intensityCurves(timeline).detail;
  const frames = intensity.length;
  const pivot = frames > 0 ? quantile(intensity, 0.5) : 0.5;
  const tMusicEnd = timeline.musicEndFrame / rate;
  // The tables run a little past the audio so the slow-down completes even on an abrupt ending.
  const n = frames > 0 ? frames + Math.ceil((PACE.endSlowS + 1) * rate) : 0;

  const vMin = PACE.minKmh * KMH_TO_UNITS_PER_S, vMax = PACE.maxKmh * KMH_TO_UNITS_PER_S;
  const lnCruise = Math.log(PACE.cruiseKmh * KMH_TO_UNITS_PER_S);
  const lnEnd = Math.log(PACE.endKmh * KMH_TO_UNITS_PER_S);
  const k = 1 - Math.exp(-1 / (PACE.followTauS * rate));

  const intervals = salts ? scheduleOf(timeline).intervals : [];
  const kSlope = 1 - Math.exp(-1 / (NETHER_PATH.followTauS * rate));
  const speed = new Float64Array(n);
  const dist = new Float64Array(n);
  const fov = new Float64Array(n);
  /** Nether leg: slope and accumulated drop (m) below the road; both 0 in the overworld. */
  const slope = new Float64Array(n);
  const drop = new Float64Array(n);
  let lnV = lnCruise;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const x = intensity[Math.min(i, frames - 1)]!;
    let lnMusic = Math.min(Math.log(vMax), Math.max(Math.log(vMin), lnCruise + PACE.intensityGain * (x - pivot)));
    const iv = intervals.find((v) => t >= v.t0 && t < v.t1);
    if (iv) {
      const steep = smoothstep(NETHER_PATH.steepFrom, NETHER_PATH.steepTo, x);
      const target = (NETHER_PATH.calmSlope + (NETHER_PATH.steepSlope - NETHER_PATH.calmSlope) * steep) * smoothstep(iv.t0, iv.t0 + NETHER_PATH.rampInS, t);
      const continuing = i > 0 && t - 1 / rate >= iv.t0; // not the first sample of the leg
      const before = continuing ? slope[i - 1]! : 0;
      slope[i] = before + (target - before) * kSlope;
      drop[i] = continuing ? drop[i - 1]! + (slope[i - 1]! * speed[i - 1]!) / rate : 0;
      lnMusic = Math.min(Math.log(vMax), lnMusic + NETHER_PATH.speedGain * Math.max(0, -slope[i]!) / -NETHER_PATH.steepSlope);
    }
    lnV = i === 0 ? lnMusic : lnV + (lnMusic - lnV) * k;
    // The epilogue blend comes after the smoothing, so the end speed is reached exactly `endSlowS` after the music.
    const ending = smoothstep(tMusicEnd, tMusicEnd + PACE.endSlowS, t);
    speed[i] = Math.exp(lnV + (lnEnd - lnV) * ending);
    fov[i] = fovForSpeed(speed[i]!);
    if (i + 1 < n) dist[i + 1] = dist[i]! + speed[i]! / rate;
  }

  const v0 = n > 0 ? speed[0]! : PACE.cruiseKmh * KMH_TO_UNITS_PER_S;
  const vEnd = n > 0 ? speed[n - 1]! : v0;
  const tEnd = n > 0 ? (n - 1) / rate : 0;
  const dEnd = n > 0 ? dist[n - 1]! : 0;

  const distanceAt = (t: number): number => {
    if (t <= 0) return t * v0;
    if (t >= tEnd) return dEnd + (t - tEnd) * vEnd;
    return sample(dist, t * rate);
  };

  const timeAt = (d: number): number => {
    if (d <= 0) return d / v0;
    if (d >= dEnd) return tEnd + (d - dEnd) / vEnd;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dist[mid]! <= d) lo = mid; else hi = mid;
    }
    const span = dist[hi]! - dist[lo]!;
    return (lo + (span > 0 ? (d - dist[lo]!) / span : 0)) / rate;
  };

  return {
    distanceAt,
    timeAt,
    // The road is flat except over bridges, where it rises and falls with the arch, and in the Nether, where it
    // descends (the same profiles the segments build). Leaving the Nether jumps back to the road: the portal flash hides it.
    heightAt: (t: number) => {
      if (!salts) return 0;
      if (intervals.some((v) => t >= v.t0 && t < v.t1)) return sample(drop, t * rate);
      return bridgeOffsetAt(salts, distanceAt(t));
    },
    slopeAt: (t: number) => {
      if (!salts) return 0;
      if (intervals.some((v) => t >= v.t0 && t < v.t1)) return sample(slope, t * rate);
      return bridgeSlopeAt(salts, distanceAt(t));
    },
    fovAt: (t: number) => (n > 0 ? sample(fov, t * rate) : fovForSpeed(v0)),
  };
}
