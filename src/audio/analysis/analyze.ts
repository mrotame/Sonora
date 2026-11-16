// Whole-track signal analysis: energy, three frequency bands and spectral flux
// at a fixed rate. Pure and DOM-free (runs in the Worker and in Node tests).
// Output is normalized per track so scenarios get comparable 0..1 ranges; this
// does not alter the PCM (which is never normalized, TECHNICAL_ARCHITECTURE 5.2).
import { FFT } from './fft.ts';
import { TRACK_NAMES, type TimelineData, type TrackName } from '../intelligence/timeline.ts';

export const FEATURE_RATE_HZ = 100;
const WINDOW = 2048;
const BASS_RANGE_HZ: [number, number] = [20, 150];
const MID_RANGE_HZ: [number, number] = [150, 2000];
const HIGH_RANGE_HZ: [number, number] = [2000, 12000];
/** Each track is divided by this percentile of its own values, then clamped to [0, 1]. */
const NORMALIZATION_PERCENTILE = 0.98;

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function analyzeTrack(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): TimelineData {
  const frames = Math.floor((left.length / sampleRate) * FEATURE_RATE_HZ) + 1;
  const hop = sampleRate / FEATURE_RATE_HZ;
  const fft = new FFT(WINDOW);
  const hann = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));

  const binHz = sampleRate / WINDOW;
  const bin = (hz: number) => Math.max(1, Math.round(hz / binHz));
  const bands = {
    bass: [bin(BASS_RANGE_HZ[0]), bin(BASS_RANGE_HZ[1])],
    mid: [bin(MID_RANGE_HZ[0]), bin(MID_RANGE_HZ[1])],
    high: [bin(HIGH_RANGE_HZ[0]), Math.min(WINDOW / 2 - 1, bin(HIGH_RANGE_HZ[1]))],
  } as const;

  const tracks = Object.fromEntries(TRACK_NAMES.map((n) => [n, new Float32Array(frames)])) as Record<TrackName, Float32Array>;
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  const prev = new Float64Array(WINDOW / 2);
  const mag = new Float64Array(WINDOW / 2);

  const bandEnergy = (range: readonly [number, number]) => {
    let e = 0;
    for (let k = range[0]; k <= range[1]; k++) e += mag[k]! * mag[k]!;
    return Math.sqrt(e);
  };

  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop) - WINDOW / 2; // window centered on the frame time
    let sumSq = 0;
    for (let i = 0; i < WINDOW; i++) {
      const idx = start + i;
      const s = idx >= 0 && idx < left.length ? (left[idx]! + right[idx]!) * 0.5 : 0;
      sumSq += s * s;
      re[i] = s * hann[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    for (let k = 0; k < WINDOW / 2; k++) {
      mag[k] = Math.hypot(re[k]!, im[k]!);
      const d = mag[k]! - prev[k]!;
      if (d > 0) flux += d;
      prev[k] = mag[k]!;
    }
    tracks.energy[f] = Math.sqrt(sumSq / WINDOW);
    tracks.bass[f] = bandEnergy(bands.bass);
    tracks.mid[f] = bandEnergy(bands.mid);
    tracks.high[f] = bandEnergy(bands.high);
    tracks.flux[f] = flux;

    if (onProgress && f % 2000 === 0) onProgress(f / frames);
  }

  for (const name of TRACK_NAMES) {
    const track = tracks[name];
    const ref = percentile(track, NORMALIZATION_PERCENTILE);
    // A track that is silent throughout stays zero instead of amplifying noise.
    const scale = ref > 1e-9 ? 1 / ref : 0;
    for (let i = 0; i < track.length; i++) track[i] = Math.min(1, track[i]! * scale);
  }
  onProgress?.(1);
  return { rate: FEATURE_RATE_HZ, durationS: left.length / sampleRate, tracks };
}
