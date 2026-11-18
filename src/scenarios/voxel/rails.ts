// Voxel Dreamscape: the Nether rail profile (pure, no Three.js, no DOM). The rails are blocks: flat on a deck layer, or
// the block game's ascending rail, a 45 degree ramp that climbs one layer across its cell (mesher.ts). The camera rides
// the smooth grade the music sets (path.ts, NETHER_PATH: a wave); `quantizeRails` lays the blocks along it in runs, so
// the track is long 45 degree ramps with level stretches between them instead of a ramp every other row. The minecart
// rides under the camera and tilts with the rails below it, as in the game: level on the flat rails, 45 degrees on the ramps.

export const RAILS = {
  /**
   * The rails keep within this band around the smooth grade (deck layer minus grade, in layers): a ramp starts when the
   * rails reach an edge and runs until the next step would cross the other side. Kept mostly below the grade, so the
   * rails never come up through the minecart that rides the grade. About 4..6 changes of the cart angle per second on
   * the steepest stretches. PROPOSED values (2026-11-18, user-requested: a minecart closer to the block game's).
   */
  below: 1.5,
  above: 0.3,
  /** Eye height (m) over the deck surface in the Nether: seated in the minecart (the overworld walk is ROAD.eyeAbove). */
  eyeAbove: 1.4,
  /** Half-width (m) of the box filter over the rails for the minecart's angle: corners turn over 0.6 m. */
  smoothM: 0.3,
} as const;

/**
 * Deck layers (offsets) for rows whose smooth target height is `target[i]`: change by at most one layer per row, stay
 * within the band [target - below, target + above] (but for a level row before a reversal), and never ramp up then
 * straight down (or down then up), so no rail has to ramp toward both of its neighbours. Pure.
 */
export function quantizeRails(target: ArrayLike<number>): Int32Array {
  const out = new Int32Array(target.length);
  if (target.length === 0) return out;
  let cur = Math.round(target[0]!), dir = 0, prev = 0;
  out[0] = cur;
  for (let i = 1; i < target.length; i++) {
    const err = cur - target[i]!;
    // Stop a run before the step would cross the far side of the band.
    if (dir < 0 && err - 1 < -RAILS.below) dir = 0;
    if (dir > 0 && err + 1 > RAILS.above) dir = 0;
    // Start one at an edge, only after a level row when it reverses the last step.
    if (dir === 0) {
      if (err > RAILS.above && prev <= 0) dir = -1;
      else if (err < -RAILS.below && prev >= 0) dir = 1;
    }
    cur += dir;
    prev = dir;
    out[i] = cur;
  }
  return out;
}

/** Deck layer of row bd, or null where there are no rails. */
export type LayerOf = (bd: number) => number | null;

/** Height of the rails' deck surface at fraction f (0..1) of row bd: level, or the ramp toward a neighbour one layer up. */
function rowSurface(layerOf: LayerOf, bd: number, f: number): number | null {
  const l = layerOf(bd);
  if (l === null) return null;
  // As the mesher: toward the next row first (toward -z), then the previous one.
  if (layerOf(bd + 1) === l + 1) return l + 1 + f;
  if (layerOf(bd - 1) === l + 1) return l + 2 - f;
  return l + 1;
}

/** Deck surface (y) under the rails at distance d (continuous: flat rows and 45 degree ramps); null without rails. */
export function railSurfaceAt(layerOf: LayerOf, d: number): number | null {
  const bd = Math.floor(d);
  return rowSurface(layerOf, bd, d - bd);
}

/** Slope of the rails at d, box-filtered over +-smoothM: 0 on level rails, 1 or -1 on a ramp, rounded at the corners. */
export function smoothRailSlopeAt(layerOf: LayerOf, d: number): number | null {
  const ya = railSurfaceAt(layerOf, d - RAILS.smoothM), yb = railSurfaceAt(layerOf, d + RAILS.smoothM);
  return ya === null || yb === null ? null : (yb - ya) / (2 * RAILS.smoothM);
}
