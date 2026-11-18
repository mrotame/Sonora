// Loading progress shown on the preparing screen. Pure and DOM-free (unit tested).
//
// Only the analysis step reports a real fraction (the Worker's `progress` messages). Acquisition only
// reports which step it is in, and decoding and world building report nothing, so those steps
// are ESTIMATES: the bar creeps asymptotically inside the step's range and never reaches the next
// step's start until that step really begins. The ranges below are a first guess at the relative
// cost of each step, not measurements.

export interface StageRange {
  from: number;
  to: number;
  /** Time constant (ms) of the creep for steps without a real fraction. */
  tauMs: number;
}

export const STAGE_RANGES: Record<string, StageRange> = {
  queued: { from: 0, to: 0.04, tauMs: 1500 },
  fetching_metadata: { from: 0.04, to: 0.1, tauMs: 2500 },
  downloading: { from: 0.1, to: 0.4, tauMs: 8000 },
  transferring: { from: 0.4, to: 0.5, tauMs: 3000 },
  decoding: { from: 0.5, to: 0.58, tauMs: 2500 },
  analyzing: { from: 0.58, to: 0.88, tauMs: 8000 },
  building: { from: 0.88, to: 1, tauMs: 4000 },
};

/** How far the creep may go inside a step's range, so it never looks finished before it is. */
const CREEP_CAP = 0.92;

/**
 * Progress in 0..1 for a step. `fraction` is the step's real progress (0..1) when it reports one;
 * otherwise the value creeps with `elapsedMs` since the step began. Unknown steps return null.
 */
export function stageProgress(stage: string, elapsedMs: number, fraction?: number): number | null {
  const range = STAGE_RANGES[stage];
  if (!range) return null;
  const inside = fraction !== undefined
    ? Math.min(1, Math.max(0, fraction))
    : CREEP_CAP * (1 - Math.exp(-Math.max(0, elapsedMs) / range.tauMs));
  return range.from + (range.to - range.from) * inside;
}

/** Whole percent for display, 0..100. */
export function toPercent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}
