// Voxel Dreamscape: music-driven camera pace (pure, no Three.js, no DOM).
// The camera follows a straight road at a fixed height (it only rises over bridges); its speed and field of view follow the music:
//   - Intensity (log loudness + spectral flux), smoothed over about 1.5 s with a centered (zero-lag) filter and
//     scaled between the song's 2nd and 98th percentile.
//   - Speed is set in log space around a cruise speed by how intense the moment is against the song's median, and
//     follows that target with a short time constant so it never jumps.
//   - The field of view widens with the speed (sense of velocity).
//   - After the music ends the speed eases down to `endKmh` for the controller's epilogue (PRODUCT_SPEC 2.4).
// Everything is a pure function of the timeline, evaluated by track time.
// Voxel Dreamscape's own scale, as requested by the user: 40 km/h in calm moments up to 100 km/h in fast ones.
import { SILENCE_LEVEL, type Timeline } from '../../audio/intelligence/timeline.ts';
import type { Seed } from '../../world/identity/seed.ts';
import type { TrackPath } from '../types.ts';
import { bridgeOffsetAt, bridgeSlopeAt } from './road.ts';
import { caveMask } from './caveMask.ts';
import { scheduleOf } from './schedule.ts';
import { saltsFor, withCaves, type TerrainSalts } from './terrain.ts';

export const PACE = {
  /** Speed range and cruise speed in km/h (1 world unit = 1 m). */
  minKmh: 40,
  maxKmh: 100,
  cruiseKmh: 63,
  /** ln(speed) gained from the song's median (0) to its most intense moment; the same amount is lost toward its calmest. */
  intensityGain: 1.6,
  /** Time constant (s) of the speed following its target. */
  followTauS: 1.2,
  /** Half-width (s) of each of two centered box passes for the moment-to-moment intensity (about 1.5 s). */
  detailS: 0.75,
  /** Half-width (s) of each of two centered box passes for the section level (about 3 s): open land, caves or Nether. */
  sectionS: 1.5,
  /** Half-width (s) of each of two centered box passes for the horizon mood (about 20 s). */
  moodS: 10,
  /** Intensity proxy: log loudness (energy in dB over `loudnessFloorDb`) and spectral flux. */
  loudnessWeight: 0.5,
  fluxWeight: 0.5,
  loudnessFloorDb: -30,
  /** Speed once the music has ended (trailing silence and epilogue), reached over `endSlowS` seconds. */
  endKmh: 25,
  endSlowS: 2.5,
  /** Vertical field of view (degrees) at the minimum and maximum speed, interpolated in log speed (40% wider than 60..84). */
  fovDeg: [84, 117.6],
  /** In the Nether the field of view widens by this factor more (capped at `fovMaxDeg`), eased in and out over `netherFovS` s after each portal. */
  netherFov: 1.12,
  fovMaxDeg: 130,
  netherFovS: 1.2,
} as const;

const KMH_TO_UNITS_PER_S = 1 / 3.6;

/**
 * Nether leg: the rails roll like a roller coaster with the music (the idea of Synthwave's road, implemented here so
 * scenarios stay independent, and measured inside the visit itself since the whole Nether is already an intense passage).
 * A moment more intense than the visit's median (or than the last few seconds) drops the minecart, the more the steeper,
 * and it picks up speed; a calmer one levels out and climbs a little, and the cart slows. Descents are steeper and
 * quicker than climbs, so each visit still goes down as a whole, into the depths.
 */
export const NETHER_PATH = {
  /** Steepest slopes (rise over run): descents (negative) are steeper than climbs. */
  maxDescent: -0.6,
  maxClimb: 0.28,
  /** Slope per unit of intensity difference; a climb needs about twice the difference of a descent for the same slope. */
  slopeGain: 2.2,
  climbScale: 0.5,
  /** Intensity quantile of the visit that rides level (below 0.5: more descent than climb). */
  pivotQuantile: 0.4,
  /** Weight of "intense for this visit" (against the pivot) vs. "more intense than the last seconds" (contrast). */
  absoluteWeight: 1,
  contrastWeight: 0.8,
  /** Half-width (s) of each of two centered box passes for the surrounding context (about 8 s). */
  contextS: 4,
  /** Time constants (s) of the slope following its target: tipping into a descent is quicker than turning uphill. */
  descentTauS: 0.35,
  climbTauS: 0.8,
  /** Ramp-in (s) after the entry portal. */
  rampInS: 1.5,
  /** ln(speed) gained at the steepest descent and lost at the steepest climb. */
  descentSpeedGain: 0.45,
  climbSpeedBrake: 0.5,
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

/**
 * Section scale (user-requested, 2026-11-17): 0 is the calmest part of the music and 1 its most intense, measured only
 * over the frames where music plays (a near-silent intro or outro would otherwise squeeze every musical passage into the
 * upper half of the scale). Robust percentiles instead of the bare minimum and maximum.
 */
export const SECTION_SCALE = { lowQ: 0.1, highQ: 0.98 } as const;


function normalizeMusic(curve: Float64Array, energy: ArrayLike<number>): Float64Array {
  const music = Float64Array.from(curve.filter((_, i) => energy[i]! > SILENCE_LEVEL));
  if (music.length < 2) return normalize(curve);
  const lo = quantile(music, SECTION_SCALE.lowQ), hi = quantile(music, SECTION_SCALE.highQ);
  if (hi - lo < 1e-9) return curve.fill(0.5);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.min(1, Math.max(0, (curve[i]! - lo) / (hi - lo)));
  return curve;
}

interface IntensityCurves {
  /** Moment-to-moment intensity (pace). */
  detail: Float64Array;
  /** Section intensity: which level the music is at (open land, caves, Nether; see schedule.ts). */
  section: Float64Array;
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
    section: normalizeMusic(blur2(raw, PACE.sectionS, rate), tracks.energy),
    mood: normalize(blur2(raw, PACE.moodS, rate)),
  };
  cache.set(timeline, curves);
  return curves;
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

/**
 * 0 in the overworld, 1 in the Nether, eased over `netherFovS` after each entry and after each exit (the portal flash
 * covers the start of both). Pure function of the intervals and the time.
 */
export function netherFovWeight(intervals: readonly { t0: number; t1: number }[], t: number): number {
  let w = 0;
  for (const iv of intervals) w = Math.max(w, smoothstep(iv.t0, iv.t0 + PACE.netherFovS, t) * (1 - smoothstep(iv.t1, iv.t1 + PACE.netherFovS, t)));
  return w;
}

interface PaceTables {
  n: number;
  rate: number;
  speed: Float64Array;
  dist: Float64Array;
  fov: Float64Array;
  slope: Float64Array;
  drop: Float64Array;
  distanceAt: (t: number) => number;
  timeAt: (d: number) => number;
  v0: number;
}

// The pace depends only on the music (and on whether the Nether is scheduled), never on the terrain, so the cave
// sections can be placed along the road from it. Memoized per timeline: a pure function of the immutable timeline.
const paceCache = new WeakMap<Timeline, Map<boolean, PaceTables>>();

function paceTables(timeline: Timeline, withNether: boolean): PaceTables {
  let perTimeline = paceCache.get(timeline);
  if (!perTimeline) paceCache.set(timeline, (perTimeline = new Map()));
  const hit = perTimeline.get(withNether);
  if (hit) return hit;
  const tables = buildPace(timeline, withNether);
  perTimeline.set(withNether, tables);
  return tables;
}

const terrainCache = new WeakMap<Timeline, WeakMap<Seed, TerrainSalts>>();

/**
 * Terrain of a world for a track: the world's salts with the cave sections of the schedule mapped to road rows (the
 * centre of the map has mountains only there). Memoized per timeline and seed object.
 */
export function voxelTerrain(timeline: Timeline, worldSeed: Seed): TerrainSalts {
  let perTimeline = terrainCache.get(timeline);
  if (!perTimeline) terrainCache.set(timeline, (perTimeline = new WeakMap()));
  const hit = perTimeline.get(worldSeed);
  if (hit) return hit;
  const pace = paceTables(timeline, true);
  const ranges = scheduleOf(timeline).caves.map((c) => [Math.floor(pace.distanceAt(c.t0)), Math.floor(pace.distanceAt(c.t1))] as const);
  const terrain = withCaves(saltsFor(worldSeed), caveMask(ranges));
  perTimeline.set(worldSeed, terrain);
  return terrain;
}

function buildPace(timeline: Timeline, withNether: boolean): PaceTables {
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

  const intervals = withNether ? scheduleOf(timeline).intervals : [];
  const kDown = 1 - Math.exp(-1 / (NETHER_PATH.descentTauS * rate));
  const kUp = 1 - Math.exp(-1 / (NETHER_PATH.climbTauS * rate));
  const context = blur2(intensity, NETHER_PATH.contextS, rate);
  // Level intensity of each visit: its own quantile, so a visit that is intense throughout still has its ups and downs.
  const pivots = intervals.map((v) => {
    const lo = Math.max(0, Math.floor(v.t0 * rate)), hi = Math.min(frames - 1, Math.ceil(v.t1 * rate));
    return hi > lo ? quantile(intensity.subarray(lo, hi + 1), NETHER_PATH.pivotQuantile) : pivot;
  });
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
    const ivIndex = intervals.findIndex((v) => t >= v.t0 && t < v.t1);
    const iv = intervals[ivIndex];
    if (iv) {
      // Positive drive = more intense than expected = downhill.
      const drive = NETHER_PATH.absoluteWeight * (x - pivots[ivIndex]!) + NETHER_PATH.contrastWeight * (x - context[Math.min(i, frames - 1)]!);
      const scaled = NETHER_PATH.slopeGain * drive * (drive > 0 ? 1 : NETHER_PATH.climbScale);
      const target = Math.max(NETHER_PATH.maxDescent, Math.min(NETHER_PATH.maxClimb, -scaled)) * smoothstep(iv.t0, iv.t0 + NETHER_PATH.rampInS, t);
      const continuing = i > 0 && t - 1 / rate >= iv.t0; // not the first sample of the leg
      const before = continuing ? slope[i - 1]! : 0;
      slope[i] = before + (target - before) * (target < before ? kDown : kUp);
      drop[i] = continuing ? drop[i - 1]! + (slope[i - 1]! * speed[i - 1]!) / rate : 0;
      // Fast on the steep descents, slower on the climbs; the ceiling is the same top speed as everywhere.
      const lnNether = lnMusic + (slope[i]! < 0 ? NETHER_PATH.descentSpeedGain * (slope[i]! / NETHER_PATH.maxDescent) : -NETHER_PATH.climbSpeedBrake * (slope[i]! / NETHER_PATH.maxClimb));
      lnMusic = Math.min(Math.log(vMax), Math.max(Math.log(vMin), lnNether));
    } else if (i > 0) {
      // Outside a leg the tables hold their last value, so a time just before the exit portal interpolates between two
      // samples of the leg and never toward 0 (that put the exit portal far above the Nether bridge, out of sight).
      slope[i] = slope[i - 1]!;
      drop[i] = drop[i - 1]!;
    }
    lnV = i === 0 ? lnMusic : lnV + (lnMusic - lnV) * k;
    // The epilogue blend comes after the smoothing, so the end speed is reached exactly `endSlowS` after the music.
    const ending = smoothstep(tMusicEnd, tMusicEnd + PACE.endSlowS, t);
    speed[i] = Math.exp(lnV + (lnEnd - lnV) * ending);
    fov[i] = Math.min(PACE.fovMaxDeg, fovForSpeed(speed[i]!) * (1 + (PACE.netherFov - 1) * netherFovWeight(intervals, t)));
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
  return { n, rate, speed, dist, fov, slope, drop, distanceAt, timeAt, v0 };
}

export function createVoxelPath(timeline: Timeline, worldSeed?: Seed): TrackPath {
  const salts = worldSeed ? voxelTerrain(timeline, worldSeed) : null;
  const { n, rate, fov, slope, drop, distanceAt, timeAt, v0 } = paceTables(timeline, salts !== null);
  const intervals = salts ? scheduleOf(timeline).intervals : [];
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
