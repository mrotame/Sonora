// Synthwave Dimension: deterministic logic (no Three.js, no DOM).
// World: a flat road along the travel axis with ridged mountains on both sides.
// Terrain is a continuous world-space field h(x, d) so segments have no seams;
// the pre-analysis shapes its amplitude along the track.
import type { Features, Timeline } from '../../audio/intelligence/timeline.ts';
import { deriveSeed, rand, rand2, type Seed } from '../../world/identity/seed.ts';
import type { ScenarioLogic, SegmentInput, TrackPath } from '../types.ts';
import { createTrackPath } from './path.ts';

export const TERRAIN = {
  halfWidth: 480,
  cellX: 2.5,
  rowStep: 2,
  roadHalf: 12,
  peak: 22,
  noiseScale: 55,
  /** Width of one "size cell": mountains of different size are separated by about this distance. */
  sizeScale: 90,
  /** A mountain appears with a size drawn from this range (multiplier of the base height). */
  startRange: [0.45, 0.8],
  /** Its size once the camera is close: most stay moderate, a few become giants (skewed draw). */
  finalRange: [0.6, 3.6],
} as const;

export interface SynthwaveSegment {
  cols: number;
  rows: number;
  halfWidth: number;
  rowStep: number;
  /** (rows + 1) * (cols + 1) heights; row r lies at startDistance + r * rowStep, column c at x = -halfWidth + c * cellX. */
  heights: Float32Array;
  /**
   * Same layout as heights. Fraction (0..1] of the final height a vertex has when the mountain is far
   * away; the vertex shader grows it to 1 as the camera approaches. `heights` holds the final height.
   */
  startRatio: Float32Array;
  /** rows + 1 values: elevation of the whole cross-section (road and mountains) at row r, from the music-driven road path. */
  roadY: Float32Array;
}

export interface SynthwaveParams {
  gridGlow: number;
  sunScale: number;
  sunGlow: number;
  flash: number;
  /** Three star populations, each lit by a different band (about 40% / 45% / 15% of the stars). */
  starBass: number;
  starMid: number;
  starHigh: number;
  /** Live relative growth of the mountains on top of the baked, pre-analysed height (0 = none). */
  mountainPulse: number;
  /** Fraction of the embers that are visible (0..1). */
  emberDensity: number;
  emberGlow: number;
  /** Constant per world: varies the skyline silhouette and ember placement between tracks. */
  worldSalt: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const smoothstep = (a: number, b: number, x: number) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));

function valueNoise(seed: Seed, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(x - ix), fz = smooth(z - iz);
  const a = rand2(seed, ix, iz), b = rand2(seed, ix + 1, iz);
  const c = rand2(seed, ix, iz + 1), d = rand2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function fbm(seed: Seed, x: number, z: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += amp * valueNoise(seed, x * freq + o * 57, z * freq);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 0.9375;
}

/**
 * Mountain height multiplier from the smoothed track energy around distance d
 * (about +-2 s of music): continuous in d, so it cannot create seams. Quiet
 * passages give low hills (0.4), loud ones tall peaks (up to 1.5).
 */
export function amplitudeAt(timeline: Timeline, d: number, speed: number, path?: TrackPath): number {
  const t = path ? path.timeAt(d) : d / speed;
  let sum = 0;
  for (let k = -2; k <= 2; k++) sum += timeline.evaluate(t + k).energy;
  return 0.4 + 1.1 * (sum / 5);
}

export function terrainHeight(terrainSeed: Seed, x: number, d: number, amplitude: number): number {
  const mask = smoothstep(TERRAIN.roadHalf + 4, TERRAIN.roadHalf + 50, Math.abs(x));
  if (mask === 0) return 0;
  const n = fbm(terrainSeed, x / TERRAIN.noiseScale, d / TERRAIN.noiseScale);
  const ridge = 1 - Math.abs(2 * n - 1);
  return mask * TERRAIN.peak * amplitude * (0.12 + 0.88 * Math.pow(ridge, 1.5));
}

/**
 * Per-mountain size: two smooth world-space fields (so a whole mountain shares one size and
 * neighbouring segments agree). Returns the size multiplier when far (start) and when near (final).
 */
export function mountainSize(sizeSeed: Seed, x: number, d: number): { start: number; final: number } {
  const [s0, s1] = TERRAIN.startRange;
  const [f0, f1] = TERRAIN.finalRange;
  const u = valueNoise(sizeSeed, x / TERRAIN.sizeScale, d / TERRAIN.sizeScale);
  const v = valueNoise(deriveSeed(sizeSeed, 'start'), x / TERRAIN.sizeScale, d / TERRAIN.sizeScale);
  // Value noise clusters around 0.5, so stretch it first, then skew it so giants are the exception.
  const stretched = Math.min(1, Math.max(0, (u - 0.2) / 0.6));
  return { start: s0 + (s1 - s0) * v, final: f0 + (f1 - f0) * Math.pow(stretched, 2) };
}

/**
 * Far-field layer (level of detail): the same continuous terrain sampled on a much coarser and wider grid, in longer
 * segments streamed far beyond the detailed ones. The scene hides it wherever detailed segments are loaded.
 */
export const FAR_TERRAIN = {
  halfWidth: 4000,
  cellX: 25,
  rowStep: 25,
  segmentLength: 500,
  segmentsAhead: 10,
  segmentsBehind: 1,
} as const;

function generateSegment(input: SegmentInput): SynthwaveSegment {
  return sampleGrid(input, TERRAIN.halfWidth, TERRAIN.cellX, TERRAIN.rowStep);
}

function generateFarSegment(input: SegmentInput): SynthwaveSegment {
  return sampleGrid(input, FAR_TERRAIN.halfWidth, FAR_TERRAIN.cellX, FAR_TERRAIN.rowStep);
}

/** Samples the continuous world fields (terrain, mountain size, road elevation) on a regular grid over one segment. */
function sampleGrid(input: SegmentInput, halfWidth: number, cellX: number, rowStep: number): SynthwaveSegment {
  const cols = Math.round((2 * halfWidth) / cellX);
  const rows = Math.round(input.length / rowStep);
  const terrainSeed = deriveSeed(input.worldSeed, 'terrain');
  const sizeSeed = deriveSeed(input.worldSeed, 'size');
  const heights = new Float32Array((rows + 1) * (cols + 1));
  const startRatio = new Float32Array((rows + 1) * (cols + 1));
  const roadY = new Float32Array(rows + 1);
  for (let r = 0; r <= rows; r++) {
    const d = input.startDistance + r * rowStep;
    // The road elevation at distance d is the height the camera has when it gets there.
    if (input.path) roadY[r] = input.path.heightAt(input.path.timeAt(d));
    const amp = amplitudeAt(input.timeline, d, input.speed, input.path);
    for (let c = 0; c <= cols; c++) {
      const x = -halfWidth + c * cellX;
      const size = mountainSize(sizeSeed, x, d);
      const i = r * (cols + 1) + c;
      heights[i] = terrainHeight(terrainSeed, x, d, amp) * size.final;
      startRatio[i] = Math.min(1, size.start / size.final);
    }
  }
  return { cols, rows, halfWidth, rowStep, heights, startRatio, roadY };
}

function interpret(f: Features, seed: Seed): SynthwaveParams {
  return {
    gridGlow: 0.55 + 0.9 * f.bass + 0.3 * f.energy,
    sunScale: 1 + 0.1 * f.bass,
    sunGlow: 0.35 + 0.65 * f.energy,
    flash: 0.6 * f.flux * f.flux,
    starBass: 0.2 + 0.8 * f.bass,
    starMid: 0.2 + 0.8 * f.mid,
    starHigh: 0.2 + 0.8 * f.high,
    mountainPulse: 0.25 * f.bass,
    emberDensity: 0.65 + 0.35 * f.energy,
    emberGlow: 0.8 + 0.8 * f.mid + 0.6 * f.flux,
    worldSalt: 1 + 99 * rand(seed, 1),
  };
}

export const synthwaveLogic: ScenarioLogic<SynthwaveParams, SynthwaveSegment> = {
  id: 'synthwave',
  // 3: much lower mountains (peak 85 -> 22) change the generated terrain.
  // 4: per-mountain size field (final heights scaled 0.6x..3.6x) plus a baked start-size ratio.
  // 5: larger start sizes (0.25..0.5 -> 0.45..0.8) change the baked start ratio.
  // 6: music-driven camera path (variable speed and road elevation); segment spacing and heights follow it.
  // 7: path rescaled: 10..100 km/h, road height 0..100, rank-normalized intensity, shorter smoothing.
  // 8: the path follows musical sections (constant slope and speed per passage, height = integral of the slope).
  // 9: faster path: 30..200 km/h, road height range doubled (2800) to fit the faster descents.
  // 11: faster camera: minimum 30 km/h (steep climbs), cruise 140 km/h.
  // 12: speed range raised to 50..300 km/h.
  // 13: wider terrain (halfWidth 160 -> 260) changes the segment layout.
  // 14: even wider terrain (halfWidth 260 -> 480).
  // 15: far-field layer (coarse terrain out to 5 km) added to the generated world.
  // 16: the road flattens over a calm or fading ending and after the music ends, and slows to 50 km/h there.
  // 17: speeds doubled: 100..600 km/h, cruise 280 km/h (end speed stays 50 km/h).
  version: 17,
  // `speed` is only the fallback for code without a path (tests); the real speed comes from createPath (see path.ts).
  // viewDistance covers the far field (5 km ahead) plus the road's height range.
  config: { segmentLength: 80, speed: 30, segmentsAhead: 10, segmentsBehind: 1, eyeHeight: 2.4, viewDistance: 7000 },
  createPath: (timeline) => createTrackPath(timeline),
  interpret,
  generateSegment,
  farField: {
    config: { segmentLength: FAR_TERRAIN.segmentLength, segmentsAhead: FAR_TERRAIN.segmentsAhead, segmentsBehind: FAR_TERRAIN.segmentsBehind },
    generateSegment: generateFarSegment,
  },
};
