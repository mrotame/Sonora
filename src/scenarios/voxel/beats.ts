// Voxel Dreamscape: beat times of the music (pure, no Three.js, no DOM), for the Nether light posts, which stand where
// the camera passes them on a beat (netherPosts.ts). The timeline has no beat events yet (ADR 0007's spike is pending), so this is a
// scenario-local estimate from its continuous tracks, to be replaced by the timeline's beats when they exist:
//   1. onset envelope: spectral flux plus the rise of the bass, minus its local mean (only the peaks remain);
//   2. one tempo for the song: the autocorrelation of the envelope, weighted toward 120 BPM (between 60 and 180);
//   3. beat tracking by dynamic programming (Ellis 2007, the method behind librosa's beat tracker): beats fall on strong
//      onsets, spaced as close to the tempo period as the music allows.
// The chain can run on at the period through passages without onsets (a quiet intro or outro): as librosa does, the
// leading and trailing beats weaker than half the beats' typical onset are trimmed (inner ones are kept, so the chain never
// skips a beat mid-song). Beats in silence are dropped too. Pure function of the timeline, memoized per timeline.
import { SILENCE_LEVEL, type Timeline } from '../../audio/intelligence/timeline.ts';

export const BEATS = {
  /** Tempo range (BPM) and the centre of the tempo prior, with its width in octaves. */
  minBpm: 60,
  maxBpm: 180,
  centreBpm: 120,
  octaveSigma: 1,
  /** Weight of the bass rise in the onset envelope (the kick drum carries the beat in most music). */
  bassWeight: 1.5,
  /** Window (s) of the local mean subtracted from the envelope. */
  meanS: 0.4,
  /** How strongly the tracker keeps the period (librosa's default, for an envelope scaled to unit deviation). */
  tightness: 100,
  /** Leading and trailing beats whose onset is below this share of the beats' RMS onset are trimmed (librosa: 0.5). */
  trim: 0.5,
} as const;

const cache = new WeakMap<Timeline, Float64Array>();
const bassCache = new WeakMap<Timeline, Float64Array>();

/** Beat times (s, increasing) of the music. Empty when the track is silent or has no onsets. */
export function beatTimes(timeline: Timeline): Float64Array {
  const hit = cache.get(timeline);
  if (hit) return hit;
  const beats = track(timeline, false);
  cache.set(timeline, beats);
  return beats;
}

/**
 * Beat times (s, increasing) of the bass line alone: the same tracker over the rise of the bass only (no spectral flux), so
 * the beats follow the kick drum and the bass notes, not the hi-hats or the melody. Used by the Nether light posts.
 */
export function bassBeatTimes(timeline: Timeline): Float64Array {
  const hit = bassCache.get(timeline);
  if (hit) return hit;
  const beats = track(timeline, true);
  bassCache.set(timeline, beats);
  return beats;
}

/** Number of beats at or before track time t (binary search). */
export function beatsUpTo(beats: ArrayLike<number>, t: number): number {
  let lo = 0, hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function track(timeline: Timeline, bassOnly: boolean): Float64Array {
  const { rate, tracks } = timeline.data;
  const n = tracks.energy.length;
  const end = Math.min(n - 1, timeline.musicEndFrame);
  if (n < 4) return new Float64Array(0);

  // 1. Onset envelope, high-passed by its local mean, scaled to unit standard deviation.
  const raw = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const rise = Math.max(0, tracks.bass[i]! - tracks.bass[i - 1]!);
    raw[i] = bassOnly ? rise : tracks.flux[i]! + BEATS.bassWeight * rise;
  }
  const r = Math.max(1, Math.round((BEATS.meanS * rate) / 2));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + raw[i]!;
  const onset = new Float64Array(n);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r), b = Math.min(n, i + r + 1);
    const v = Math.max(0, raw[i]! - (prefix[b]! - prefix[a]!) / (b - a));
    onset[i] = v;
    sum += v;
    sumSq += v * v;
  }
  const sd = Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2));
  if (sd < 1e-9) return new Float64Array(0);
  for (let i = 0; i < n; i++) onset[i]! /= sd;

  // 2. Tempo period (frames): the autocorrelation peak under a log-normal prior around the centre tempo.
  const lagLo = Math.max(2, Math.floor((60 * rate) / BEATS.maxBpm)), lagHi = Math.ceil((60 * rate) / BEATS.minBpm);
  const centre = (60 * rate) / BEATS.centreBpm;
  let period = centre, best = -Infinity;
  for (let lag = lagLo; lag <= lagHi && lag < n; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < n; i++) ac += onset[i]! * onset[i + lag]!;
    ac /= n - lag;
    const w = Math.exp(-0.5 * (Math.log2(lag / centre) / BEATS.octaveSigma) ** 2);
    if (ac * w > best) { best = ac * w; period = lag; }
  }

  // 3. Dynamic programming: the best chain of beats ending at each frame, each step penalised by how far it is from
  // the period (log ratio squared), searched over steps of half to twice the period.
  const score = new Float64Array(n), link = new Int32Array(n).fill(-1);
  const stepLo = Math.max(1, Math.round(period / 2)), stepHi = Math.round(2 * period);
  for (let i = 0; i < n; i++) {
    let bestPrev = -1, bestVal = 0;
    for (let s = stepLo; s <= stepHi && i - s >= 0; s++) {
      const lr = Math.log(s / period);
      const v = score[i - s]! - BEATS.tightness * lr * lr;
      if (bestPrev < 0 || v > bestVal) { bestVal = v; bestPrev = i - s; }
    }
    if (bestPrev >= 0 && bestVal > 0) { score[i] = onset[i]! + bestVal; link[i] = bestPrev; }
    else score[i] = onset[i]!;
  }
  // The chain ends at the best frame of the last period of the music.
  let last = end;
  for (let i = Math.max(0, end - Math.round(period)); i <= end; i++) if (score[i]! > score[last]!) last = i;
  const frames: number[] = [];
  for (let i = last; i >= 0; i = link[i]!) frames.push(i);
  frames.reverse();
  // Onset at a beat: the strongest within two frames (10 ms each way: an onset peak and the beat may be a frame apart).
  const at = (f: number) => { let m = 0; for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) m = Math.max(m, onset[k]!); return m; };
  const rms = Math.sqrt(frames.reduce((s, f) => s + at(f) ** 2, 0) / Math.max(1, frames.length));
  let a = 0, b = frames.length;
  while (a < b && at(frames[a]!) < BEATS.trim * rms) a++;
  while (b > a && at(frames[b - 1]!) < BEATS.trim * rms) b--;
  return Float64Array.from(frames.slice(a, b).filter((f) => tracks.energy[f]! > SILENCE_LEVEL).map((f) => f / rate));
}
