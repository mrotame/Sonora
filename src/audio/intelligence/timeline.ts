// Musical timeline (TECHNICAL_ARCHITECTURE 6): immutable after analysis and
// evaluated statelessly by time. This slice has continuous tracks only; typed
// events (beats, sections) arrive with the analysis spike (ADR 0007).

export const TRACK_NAMES = ['energy', 'bass', 'mid', 'high', 'flux'] as const;
export type TrackName = (typeof TRACK_NAMES)[number];

/** Feature values at one instant; all normalized to roughly [0, 1]. */
export type Features = Record<TrackName, number>;

export interface TimelineData {
  /** Track sampling rate in Hz (initial value 100). */
  rate: number;
  durationS: number;
  /** Frame i describes time i / rate. All tracks have the same length. */
  tracks: Record<TrackName, Float32Array>;
}

/** Normalized energy (relative to the track's 98th percentile) below which a frame counts as silence (about -40 dB). */
export const SILENCE_LEVEL = 0.01;

export class Timeline {
  readonly data: TimelineData;
  constructor(data: TimelineData) {
    this.data = data;
  }

  get durationS(): number {
    return this.data.durationS;
  }

  /**
   * Index of the last frame that is not silence: where the music ends, before any trailing silence. A track
   * that is silent throughout returns its last frame (the whole track counts as "the music"). The audio itself is
   * never trimmed; this only tells consumers where the music stops.
   */
  get musicEndFrame(): number {
    const energy = this.data.tracks.energy;
    for (let i = energy.length - 1; i >= 0; i--) if (energy[i]! > SILENCE_LEVEL) return i;
    return Math.max(0, energy.length - 1);
  }

  /** Track time (s) at which the music ends (see `musicEndFrame`), at most the track duration. */
  get musicEndS(): number {
    return Math.min(this.data.durationS, this.musicEndFrame / this.data.rate);
  }

  /** Linear interpolation; times outside the track clamp to its ends. Pure function of `t`. */
  evaluate(t: number, out: Features = { energy: 0, bass: 0, mid: 0, high: 0, flux: 0 }): Features {
    const n = this.data.tracks.energy.length;
    if (n === 0) {
      for (const name of TRACK_NAMES) out[name] = 0;
      return out;
    }
    const pos = Math.min(Math.max(t * this.data.rate, 0), n - 1);
    const i = Math.floor(pos);
    const j = Math.min(i + 1, n - 1);
    const f = pos - i;
    for (const name of TRACK_NAMES) {
      const track = this.data.tracks[name];
      out[name] = track[i]! * (1 - f) + track[j]! * f;
    }
    return out;
  }
}
