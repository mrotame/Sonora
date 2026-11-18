// Voxel Dreamscape: where along the road the cave sections are (pure, no imports, no Three.js, no DOM).
// A cave section is a range of block rows [d0, d1) inside a mountain that rises around the road only there; outside
// them the centre of the map has no mountains. The mass of the mountain starts `CAVE_MASK.approach` rows before the
// mouth and ends as long after the exit, so the camera sees it coming. Built from the schedule (track times) and the
// path (distances), so it is a pure function of the timeline and the world.

export const CAVE_MASK = {
  /** Rows over which the mountain rises before a cave mouth (and falls after the exit). */
  approach: 64,
} as const;

export interface CaveMask {
  /** Sorted, disjoint row ranges [d0, d1) of the cave interiors. */
  ranges: readonly (readonly [number, number])[];
}

export const NO_CAVES: CaveMask = { ranges: [] };

export function caveMask(ranges: readonly (readonly [number, number])[]): CaveMask {
  return { ranges: ranges.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as const).sort((p, q) => p[0] - q[0]) };
}

/** The cave range that contains row (or distance) d, or null. */
export function caveRangeAt(mask: CaveMask, d: number): readonly [number, number] | null {
  for (const r of mask.ranges) if (d >= r[0] && d < r[1]) return r;
  return null;
}

const smooth = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/** 1 inside a cave, easing to 0 over `approach` rows before its mouth and after its exit; 0 elsewhere. */
export function caveWeight(mask: CaveMask, d: number): number {
  let w = 0;
  for (const [a, b] of mask.ranges) {
    if (d >= a && d < b) return 1;
    if (d < a) w = Math.max(w, smooth(1 - (a - d) / CAVE_MASK.approach));
    else w = Math.max(w, smooth(1 - (d - b) / CAVE_MASK.approach));
  }
  return w;
}
