// Voxel Dreamscape: floating archipelagos, the signature (pure, no Three.js, no DOM). Clusters are cells of a coarse
// world-space grid; each one is a piece of the ground that breaks off and rises as the camera approaches. The more intense
// the music where the camera meets it, the more pieces break off and the higher they rise. A cluster's decision is a pure
// function of the world seed and the slow intensity of the music at the time the camera reaches it.
import type { Timeline } from '../../audio/intelligence/timeline.ts';
import { deriveSeed, rand, type Seed } from '../../world/identity/seed.ts';
import type { TrackPath } from '../types.ts';
import { lerp, perlin2, saltOf } from './noise.ts';
import { islandIntensityAt } from './path.ts';
import { TERRAIN } from './terrain.ts';

export const ISLANDS = {
  /** Cluster grid cell (blocks). */
  clusterSize: 64,
  /** Island radius range (blocks). */
  radius: [14, 30],
  /** Share of clusters that break off: from calm (0) to most intense (1). */
  density: [0.1, 0.75],
  /** Altitude (blocks) above the original position: from calm to most intense. The minimum keeps the thickest island
   * bottom well above the camera. */
  altitude: [45, 140],
  /** Per-island altitude spread (multiplier range). */
  altitudeSpread: [0.8, 1.3],
  /** Rock below the island top: thicker in the centre (stalactite shape). */
  thickness: [3, 26],
  /** While rising, islands also drift toward the road by this share of their distance (at most `driftMax`). */
  drift: 0.4,
  driftMax: 70,
  /** Clusters whose centre is closer than this to the road do not break off. */
  minCentreX: 30,
  /** Columns closer than this to the road never belong to an island. */
  roadClear: 10,
  /** Rise window: an island is part of the ground more than `start` metres ahead of the camera, at full altitude from `done`. */
  rise: { start: 330, done: 120 },
  portalChance: [0.3, 0.7],
  amethystChance: 0.65,
} as const;

export interface Cluster {
  cx: number;
  cd: number;
  radius: number;
  /** Final altitude above its original position, 0 when it does not break off. */
  altitude: number;
  thickness: number;
  phase: number;
  id: number;
  intensity: number;
  drift: number;
}

const idOf = (i: number, j: number) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) | 0;

export interface IslandContext {
  seed: Seed;
  salt: number;
  timeline: Timeline;
  path: TrackPath | undefined;
  speed: number;
  clusters: Map<string, Cluster>;
}

export function islandContext(worldSeed: Seed, timeline: Timeline, path: TrackPath | undefined, speed: number): IslandContext {
  const seed = deriveSeed(worldSeed, 'islands');
  return { seed, salt: saltOf(seed), timeline, path, speed, clusters: new Map() };
}

/** Cluster for coarse cell (i, j) along x and d. Pure: the same cell always gives the same island. */
export function clusterAt(ctx: IslandContext, i: number, j: number): Cluster {
  const key = i + ',' + j;
  const hit = ctx.clusters.get(key);
  if (hit) return hit;
  const { seed } = ctx;
  const id = idOf(i, j);
  const C = ISLANDS.clusterSize;
  const cx = (i + 0.2 + 0.6 * rand(seed, id)) * C;
  const cd = (j + 0.2 + 0.6 * rand(seed, id + 1)) * C;
  const t = ctx.path ? ctx.path.timeAt(cd) : cd / ctx.speed;
  const intensity = islandIntensityAt(ctx.timeline, t);
  const radius = lerp(ISLANDS.radius[0], ISLANDS.radius[1], rand(seed, id + 2));
  const density = lerp(ISLANDS.density[0], ISLANDS.density[1], intensity);
  const breaks = Math.abs(cx) >= ISLANDS.minCentreX && Math.abs(cx) + radius < TERRAIN.halfWidth - 6 && rand(seed, id + 3) < density;
  const spread = lerp(ISLANDS.altitudeSpread[0], ISLANDS.altitudeSpread[1], rand(seed, id + 4));
  const altitude = breaks ? Math.round(lerp(ISLANDS.altitude[0], ISLANDS.altitude[1], intensity) * spread) : 0;
  const thickness = Math.round(lerp(ISLANDS.thickness[0] + 8, ISLANDS.thickness[1], rand(seed, id + 5)));
  const drift = -Math.sign(cx) * Math.min(Math.abs(cx) * ISLANDS.drift, ISLANDS.driftMax);
  const cluster: Cluster = { cx, cd, radius, altitude, thickness, phase: rand(seed, id + 6), id, intensity, drift };
  ctx.clusters.set(key, cluster);
  return cluster;
}

export interface Membership {
  cluster: Cluster;
  /** Rock thickness (blocks) of this column: the island takes the top `thick` blocks of the ground. */
  thick: number;
}

/** Breaking cluster that the column (bx, bd) belongs to, if any: the nearest centre among the 3x3 neighbourhood, with an irregular edge. */
export function islandOf(ctx: IslandContext, bx: number, bd: number): Membership | null {
  if (Math.abs(bx) < ISLANDS.roadClear) return null;
  const C = ISLANDS.clusterSize;
  const i0 = Math.floor(bx / C), j0 = Math.floor(bd / C);
  let best: Membership | null = null;
  let bestW = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const c = clusterAt(ctx, i0 + di, j0 + dj);
      if (c.altitude === 0) continue;
      const edge = c.radius * (0.72 + 0.56 * (0.5 + 0.5 * perlin2(ctx.salt, bx / 11 + c.id * 0.01, bd / 11)));
      const dist = Math.hypot(bx - c.cx, bd - c.cd);
      if (dist >= edge) continue;
      const w = 1 - dist / edge;
      if (w > bestW) {
        bestW = w;
        best = { cluster: c, thick: Math.max(ISLANDS.thickness[0], Math.round(ISLANDS.thickness[0] + (c.thickness - ISLANDS.thickness[0]) * Math.pow(w, 0.7))) };
      }
    }
  }
  return best;
}
