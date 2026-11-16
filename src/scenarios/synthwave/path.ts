// Synthwave Dimension: music-driven camera path (pure, no Three.js, no DOM).
// Audiosurf-style continuous model: the road follows the song second by second, with no discrete levels.
//   - Intensity (log loudness + spectral flux) is smoothed over about 1.5 s with a centered (zero-lag) filter,
//     so a change shows up when it happens in the music, and small changes still bend the road a little.
//   - The slope comes from how intense the moment is, both against the whole song and against the last
//     ~20 s (contrast): calmer than the surroundings climbs, more intense descends; the bigger the difference,
//     the steeper. Like Audiosurf 2's defaults, descents are about twice as steep as climbs for the same
//     difference and the road tips into a descent twice as fast as it turns uphill.
//   - Speed is set in log space by intensity and slope: intense passages cruise faster, a steep climb brakes
//     more than a gentle one, a steep descent accelerates more than a gentle one.
// The road height is the integral of the slope along the way, so the song as a whole drifts downhill.
// Ending: if the last ~10 s of music (before any trailing silence) are calm or fade out, the road eases to flat so
// the final shot shows the city and the sunset together. Once the music has ended the road is always flat and the
// speed eases down to `endKmh` for the controller's epilogue.
// Everything is a pure function of the timeline, evaluated by track time, so seeking and regeneration
// reproduce the same result (TECHNICAL_ARCHITECTURE 7.4).
// Ratios marked AS2 come from Audiosurf 2's modding defaults (GameplaySettings: playerminspeed 0.1,
// playermaxspeed 2.9, uphilltiltscaler 0.8, downhilltiltscaler 1.55, uphilltiltsmoother 0.03,
// downhilltiltsmoother 0.06; community docs github.com/DeathByNukes/as2-doc). The km/h scale is ours.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import type { TrackPath } from '../types.ts';

export const PATH = {
  /** Speed range in km/h (1 world unit = 1 m). The floor is the speed on the steepest, calmest climbs. */
  minKmh: 100,
  maxKmh: 600,
  /** Speed on flat road at an average intensity. */
  cruiseKmh: 280,
  /** ln(speed) gained from the quietest (-) to the most intense (+) moment, on flat road: +-intensityGain / 2. */
  intensityGain: 1.2,
  /** ln(speed) change at the steepest descent / climb (|slope| = maxSlope). Climbs brake more than descents speed up. */
  descentGain: 0.6,
  climbGain: 0.9,
  /** Steepest slope (rise over run) after scaling: 0.75 is about 37 degrees. */
  maxSlope: 0.75,
  /** Slope per unit of intensity difference, before the AS2 up/down scalers. */
  slopeGain: 1.6,
  /** AS2 uphilltiltscaler / downhilltiltscaler. */
  uphillScale: 0.8,
  downhillScale: 1.55,
  /** Time constants (s) of the slope following its target: AS2 downhill smoother is twice the uphill one. */
  uphillTauS: 0.8,
  downhillTauS: 0.4,
  /** Half-width (s) of each of two centered box passes for the moment-to-moment intensity (about 1.5 s). */
  detailS: 0.75,
  /** Half-width (s) of each of two centered box passes for the surrounding context (about 20 s). */
  contextS: 10,
  /** Intensity quantile of the song that rides flat: calmer climbs, more intense descends (0.5 = median, so a mostly loud song still climbs in its calmer parts). */
  pivotQuantile: 0.5,
  /** Weight of "intense for this song" (against the pivot) vs. "more intense than the surroundings" in the slope. */
  absoluteWeight: 1.0,
  contrastWeight: 0.8,
  /** Intensity proxy: log loudness (energy in dB over `loudnessFloorDb`) and spectral flux. */
  loudnessWeight: 0.5,
  fluxWeight: 0.5,
  loudnessFloorDb: -30,
  /** Length (s) of the ending window before the music ends, and how long before it the road starts to flatten (so the window itself rides flat). */
  endingS: 10,
  endingFlattenS: 3,
  /** The ending is calm when its mean intensity is `calmAbovePivot` (none) .. `calmBelowPivot` (full) below the song's pivot. */
  calmAbovePivot: -0.05,
  calmBelowPivot: 0.15,
  /** ...or fades out when the mean intensity of its first `fadeProbeS` exceeds that of its last `fadeProbeS` by `fadeDrop` (none .. full). */
  fadeProbeS: 2.5,
  fadeDrop: [0.1, 0.3],
  /** Speed once the music has ended (trailing silence and epilogue), reached over `endSlowS` seconds. */
  endKmh: 50,
  endSlowS: 2.5,
} as const;

const KMH_TO_UNITS_PER_S = 1 / 3.6;

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

/** Value at quantile q (0..1) of the samples. */
function quantile(values: Float64Array, q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/** Linear interpolation of a uniformly sampled table; positions outside clamp to its ends. */
function sample(table: Float64Array, pos: number): number {
  const last = table.length - 1;
  const p = Math.min(Math.max(pos, 0), last);
  const i = Math.floor(p);
  const j = Math.min(i + 1, last);
  return table[i]! + (table[j]! - table[i]!) * (p - i);
}

/**
 * Per-frame intensity of the song, 0 (its calmest) .. 1 (its most intense), smoothed over `detailS`. Scaled
 * between the 2nd and 98th percentile so every song uses the whole range (AS2 normalizes intensity by the
 * most intense part of the song too).
 */
export function intensityTrack(timeline: Timeline): Float64Array {
  const { rate, tracks } = timeline.data;
  const n = tracks.energy.length;
  const raw = new Float64Array(n);
  const floor = PATH.loudnessFloorDb;
  for (let i = 0; i < n; i++) {
    const db = 20 * Math.log10(Math.max(tracks.energy[i]!, 1e-6)); // energy is already scaled by the song's own peak
    const loud = Math.min(1, Math.max(0, 1 - db / floor));
    raw[i] = PATH.loudnessWeight * loud + PATH.fluxWeight * tracks.flux[i]!;
  }
  const smooth = blur2(raw, PATH.detailS, rate);
  if (n < 2) return smooth.fill(0.5);
  const lo = quantile(smooth, 0.02), hi = quantile(smooth, 0.98);
  if (hi - lo < 1e-9) return smooth.fill(0.5); // no contrast at all: flat road, cruise speed
  for (let i = 0; i < n; i++) smooth[i] = Math.min(1, Math.max(0, (smooth[i]! - lo) / (hi - lo)));
  return smooth;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/**
 * How calm the ending is: 0 (keep following the music) .. 1 (calm or fading out: flat road). Looks at the `endingS`
 * seconds before the music ends, leaving out the last ~1.5 s whose smoothed intensity is already pulled down by the
 * silence that follows (otherwise every abrupt ending would look like a fade-out).
 */
export function endingCalmness(intensity: Float64Array, endFrame: number, pivot: number, rate: number): number {
  const end = Math.max(0, endFrame - Math.round(2 * PATH.detailS * rate));
  const start = Math.max(0, endFrame - Math.round(PATH.endingS * rate));
  const len = end - start + 1;
  if (len < 2) return 0; // too short to tell: leave the road as the music made it
  const mean = (lo: number, hi: number) => {
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += intensity[i]!;
    return sum / (hi - lo + 1);
  };
  const probe = Math.max(1, Math.min(Math.floor(len / 2), Math.round(PATH.fadeProbeS * rate)));
  const calm = smoothstep(pivot - PATH.calmAbovePivot, pivot - PATH.calmBelowPivot, mean(start, end));
  const drop = mean(start, start + probe - 1) - mean(end - probe + 1, end);
  return Math.max(calm, smoothstep(PATH.fadeDrop[0], PATH.fadeDrop[1], drop));
}

export function createTrackPath(timeline: Timeline): TrackPath {
  const { rate } = timeline.data;
  const intensity = intensityTrack(timeline);
  const frames = intensity.length;
  const context = blur2(intensity, PATH.contextS, rate);
  const pivot = frames > 0 ? quantile(intensity, PATH.pivotQuantile) : 0.5;

  // Ending: how much the road flattens at time t, and the slow-down once the music has ended.
  const endFrame = timeline.musicEndFrame;
  const tMusicEnd = endFrame / rate;
  const calmness = frames > 0 ? endingCalmness(intensity, endFrame, pivot, rate) : 0;
  const flattenAt = (t: number) =>
    t >= tMusicEnd ? 1 : calmness * smoothstep(tMusicEnd - PATH.endingS - PATH.endingFlattenS, tMusicEnd - PATH.endingS, t);
  const lnEnd = Math.log(PATH.endKmh * KMH_TO_UNITS_PER_S);
  // The tables run a little past the end of the audio so the slow-down and flattening complete even when the music
  // stops abruptly; beyond them the path continues at its last (slow, flat) state.
  const n = frames > 0 ? frames + Math.ceil((PATH.endSlowS + 1) * rate) : 0;

  const vMin = PATH.minKmh * KMH_TO_UNITS_PER_S, vMax = PATH.maxKmh * KMH_TO_UNITS_PER_S;
  const lnCruise = Math.log(PATH.cruiseKmh * KMH_TO_UNITS_PER_S);
  const kUp = 1 - Math.exp(-1 / (PATH.uphillTauS * rate));
  const kDown = 1 - Math.exp(-1 / (PATH.downhillTauS * rate));

  const speed = new Float64Array(n);
  const slope = new Float64Array(n);
  const height = new Float64Array(n);
  const dist = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.min(i, frames - 1); // past the audio, hold its last frame (the road is flat there anyway)
    const x = intensity[k]!;
    // Positive drive = more intense than expected = downhill.
    const drive = PATH.absoluteWeight * (x - pivot) + PATH.contrastWeight * (x - context[k]!);
    const scaled = PATH.slopeGain * drive * (drive > 0 ? PATH.downhillScale : PATH.uphillScale);
    const target = Math.max(-PATH.maxSlope, Math.min(PATH.maxSlope, -scaled)) * (1 - flattenAt(t));
    // Follow the target: tipping downward (or flattening a climb) is quicker than turning upward.
    s += (target - s) * (target < s ? kDown : kUp);
    if (i === 0) s = target;
    slope[i] = s;

    const steep = s / PATH.maxSlope; // -1 (steepest descent) .. +1 (steepest climb)
    const lnMusic = lnCruise + PATH.intensityGain * (x - pivot) - (steep > 0 ? PATH.climbGain : PATH.descentGain) * steep;
    const ending = smoothstep(tMusicEnd, tMusicEnd + PATH.endSlowS, t);
    const lnV = lnMusic + (lnEnd - lnMusic) * ending;
    // The floor eases to the end speed too, which may be below the music's minimum.
    const floor = Math.exp(Math.log(vMin) + (lnEnd - Math.log(vMin)) * ending);
    speed[i] = Math.min(vMax, Math.max(Math.min(vMin, floor), Math.exp(lnV)));
    if (i + 1 < n) {
      dist[i + 1] = dist[i]! + speed[i]! / rate;
      height[i + 1] = height[i]! + (slope[i]! * speed[i]!) / rate;
    }
  }

  const v0 = n > 0 ? speed[0]! : vMin;
  const vEnd = n > 0 ? speed[n - 1]! : vMin;
  const tEnd = n > 0 ? (n - 1) / rate : 0;
  const dEnd = n > 0 ? dist[n - 1]! : 0;

  const distanceAt = (t: number): number => {
    if (t <= 0) return t * v0; // continuous extension before the start
    if (t >= tEnd) return dEnd + (t - tEnd) * vEnd; // and after the end
    return sample(dist, t * rate);
  };

  const timeAt = (d: number): number => {
    if (d <= 0) return d / v0;
    if (d >= dEnd) return tEnd + (d - dEnd) / vEnd;
    // dist is strictly increasing (speed > 0): binary search for dist[lo] <= d < dist[lo + 1].
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dist[mid]! <= d) lo = mid; else hi = mid;
    }
    const span = dist[hi]! - dist[lo]!;
    return (lo + (span > 0 ? (d - dist[lo]!) / span : 0)) / rate;
  };

  const heightAt = (t: number): number => (n > 0 ? sample(height, t * rate) : 0);
  const slopeAt = (t: number): number => (n > 0 ? sample(slope, t * rate) : 0);

  return { distanceAt, timeAt, heightAt, slopeAt };
}
